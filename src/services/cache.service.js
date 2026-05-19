// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Two-Tier Cache
//
// L1: in-process LRU-ish map with TTL (microseconds — same lambda
//     invocation reuses; protects DB from hot-path bursts).
// L2: Redis (shared across instances — protects DB from horizontal
//     fan-out and survives lambda cold starts).
//
// Both layers degrade silently. If Redis is unreachable, L1 still
// works. If both fail, the loader is just invoked.
// ═══════════════════════════════════════════════════════════════

const { getRedis, safeCall } = require('../config/redis');
const logger = require('../config/logger');

const L1_MAX_ENTRIES = 1000;
const NEGATIVE_TTL_MS = 2000; // Don't hammer DB if loader returned null

class L1 {
    constructor(max = L1_MAX_ENTRIES) {
        this.max = max;
        this.store = new Map(); // key -> { value, expiresAt }
    }

    get(key) {
        const entry = this.store.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt && entry.expiresAt < Date.now()) {
            this.store.delete(key);
            return undefined;
        }
        // Refresh recency
        this.store.delete(key);
        this.store.set(key, entry);
        return entry.value;
    }

    set(key, value, ttlMs) {
        if (this.store.size >= this.max) {
            // Evict oldest (first inserted)
            const oldest = this.store.keys().next().value;
            if (oldest !== undefined) this.store.delete(oldest);
        }
        const expiresAt = ttlMs ? Date.now() + ttlMs : 0;
        this.store.set(key, { value, expiresAt });
    }

    delete(key) {
        this.store.delete(key);
    }

    clear() {
        this.store.clear();
    }

    size() {
        return this.store.size;
    }
}

const l1 = new L1();

function serialize(value) {
    return JSON.stringify({ v: value });
}

function deserialize(raw) {
    if (raw == null) return undefined;
    try {
        const parsed = JSON.parse(raw);
        return parsed?.v;
    } catch (err) {
        return undefined;
    }
}

/**
 * Get a value, falling through L1 → L2 → loader. Caches positive *and*
 * negative results (negative for a shorter window). Always swallows
 * Redis errors. Loader exceptions propagate to the caller.
 *
 * @param {string} key
 * @param {() => Promise<*>} loader
 * @param {{ ttlMs?: number, l1TtlMs?: number, swrMs?: number }} [opts]
 */
async function getOrLoad(key, loader, opts = {}) {
    const ttlMs = Math.max(0, opts.ttlMs ?? 30000);
    const l1TtlMs = Math.max(0, opts.l1TtlMs ?? Math.min(ttlMs, 5000));

    // L1
    const fromL1 = l1.get(key);
    if (fromL1 !== undefined) return fromL1?.__null === true ? null : fromL1;

    // L2 (Redis)
    const redis = getRedis();
    if (redis) {
        const raw = await safeCall(redis.get(key), 'cache.get');
        const fromL2 = deserialize(raw);
        if (fromL2 !== undefined) {
            l1.set(key, fromL2 === null ? { __null: true } : fromL2, l1TtlMs);
            return fromL2;
        }
    }

    // Loader
    let value;
    try {
        value = await loader();
    } catch (err) {
        // Don't cache thrown errors — surface upstream.
        throw err;
    }

    const ttlForThis = value == null ? NEGATIVE_TTL_MS : ttlMs;
    l1.set(key, value === null ? { __null: true } : value, Math.min(ttlForThis, l1TtlMs || ttlForThis));

    if (redis && ttlForThis > 0) {
        const px = Math.max(1, Math.round(ttlForThis));
        await safeCall(redis.set(key, serialize(value), 'PX', px), 'cache.set');
    }

    return value;
}

async function invalidate(key) {
    l1.delete(key);
    const redis = getRedis();
    if (redis) await safeCall(redis.del(key), 'cache.del');
}

/**
 * Invalidate every key matching a prefix. Uses SCAN to avoid blocking
 * Redis. Safe to call from rule-update hooks.
 */
async function invalidatePrefix(prefix) {
    // L1: walk and delete (small, in-process).
    for (const k of Array.from(l1.store.keys())) {
        if (k.startsWith(prefix)) l1.delete(k);
    }
    const redis = getRedis();
    if (!redis) return;
    try {
        let cursor = '0';
        do {
            const reply = await safeCall(
                redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100),
                'cache.scan',
            );
            if (!Array.isArray(reply)) break;
            cursor = reply[0];
            const keys = reply[1] || [];
            if (keys.length > 0) {
                await safeCall(redis.del(...keys), 'cache.del.bulk');
            }
        } while (cursor !== '0');
    } catch (err) {
        logger.warn('cache.invalidatePrefix failed', { prefix, message: err.message });
    }
}

function stats() {
    return { l1Size: l1.size(), l1Max: L1_MAX_ENTRIES };
}

function _resetForTests() {
    l1.clear();
}

module.exports = { getOrLoad, invalidate, invalidatePrefix, stats, _resetForTests };
