// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Short-lived distributed lock
//
// Uses Redis `SET NX PX` to coordinate exclusive operations across
// instances (gate entry dedupe, mess scan dedupe). If Redis is
// unavailable, `withLock` returns `null` from the lock acquisition
// and the caller should decide whether to proceed unprotected.
// ═══════════════════════════════════════════════════════════════

const { getRedis, safeCall } = require('../config/redis');

/**
 * Try to acquire a lock; returns a release function on success, or
 * `null` if the lock is already held / Redis is unreachable.
 */
async function acquire(key, ttlMs = 2000) {
    const redis = getRedis();
    if (!redis) return null;

    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const ok = await safeCall(redis.set(`lock:${key}`, token, 'PX', ttlMs, 'NX'), 'lock.acquire');
    if (ok !== 'OK') return null;

    return async function release() {
        // Only delete if we still own it.
        try {
            const current = await safeCall(redis.get(`lock:${key}`), 'lock.get');
            if (current === token) {
                await safeCall(redis.del(`lock:${key}`), 'lock.del');
            }
        } catch {
            /* ignore */
        }
    };
}

/**
 * Try to run `fn` while holding a lock. If the lock cannot be acquired,
 * `onLocked` is called (if provided) or the function returns `undefined`.
 *
 * IMPORTANT: If Redis is down, the lock cannot be acquired and the
 * caller's `onLocked` will fire. Callers that need to proceed regardless
 * (best-effort dedupe) should fall back to `fn()` inside `onLocked`.
 */
async function withLock(key, ttlMs, fn, onLocked) {
    const release = await acquire(key, ttlMs);
    if (!release) {
        if (typeof onLocked === 'function') return onLocked();
        return undefined;
    }
    try {
        return await fn();
    } finally {
        await release();
    }
}

module.exports = { acquire, withLock };
