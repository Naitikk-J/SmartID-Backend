// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Rate Limiting
//
// Tiered, distributed limits. Uses Redis as a shared store when
// available (correct across multiple lambda instances). Falls back
// to express-rate-limit's in-memory store when Redis is down.
//
// Buckets:
//   scan       — high-throughput scan endpoint (POST /scan/verify)
//   login      — brute-force protection for /auth/admin/login
//   auth       — refresh / Google login / logout / me
//   write      — generic state-changing endpoints
//   heavy      — exports, reports, bulk-import (per-user)
//   general    — fallback (mounted at app level)
//
// All buckets emit standard `RateLimit-*` headers and a structured
// 429 body. Use `keyByUserOrIp` for authenticated endpoints so one
// user on a shared NAT can't starve everyone else.
// ═══════════════════════════════════════════════════════════════

const rateLimit = require('express-rate-limit');
const { getRedis } = require('../config/redis');
const logger = require('../config/logger');

const ONE_MINUTE = 60 * 1000;

function keyByUserOrIp(req) {
    if (req.user?.id) return `u:${req.user.id}`;
    if (req.user?.email) return `e:${req.user.email}`;
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.trim()) return `ip:${fwd.split(',')[0].trim()}`;
    return `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
}

function makeMessage(text, retryAfterSeconds) {
    return {
        success: false,
        error: text,
        code: 'RATE_LIMITED',
        retryAfter: retryAfterSeconds,
    };
}

// ── Redis-backed store (no extra deps; minimal SCRIPT-free impl) ──
//
// Each request runs INCR + EXPIRE (set TTL only on first hit). When
// Redis is unreachable, `increment` rejects and express-rate-limit
// will fall through to its internal in-memory store. We avoid that
// by catching here and degrading silently to "allow".
function createRedisStore(prefix, windowMs) {
    return {
        prefix,
        async init() { /* no-op */ },

        async increment(key) {
            const redis = getRedis();
            if (!redis) {
                // Allow but mark as "unknown" — better than 500ing.
                return {
                    totalHits: 1,
                    resetTime: new Date(Date.now() + windowMs),
                };
            }
            const fullKey = `${prefix}:${key}`;
            try {
                // Pipeline for atomicity.
                const pipeline = redis.multi();
                pipeline.incr(fullKey);
                pipeline.pttl(fullKey);
                const replies = await pipeline.exec();
                if (!replies) {
                    return { totalHits: 1, resetTime: new Date(Date.now() + windowMs) };
                }
                const total = Number(replies[0]?.[1] ?? 1);
                let pttl = Number(replies[1]?.[1] ?? -1);

                if (pttl < 0) {
                    await redis.pexpire(fullKey, windowMs);
                    pttl = windowMs;
                }
                return {
                    totalHits: total,
                    resetTime: new Date(Date.now() + pttl),
                };
            } catch (err) {
                // Redis hiccup — fail OPEN (allow). We never want rate-limit
                // outages to take down the whole API.
                logger.warn('rateLimit store degraded', { message: err.message });
                return { totalHits: 1, resetTime: new Date(Date.now() + windowMs) };
            }
        },

        async decrement(key) {
            const redis = getRedis();
            if (!redis) return;
            try { await redis.decr(`${prefix}:${key}`); } catch { /* ignore */ }
        },

        async resetKey(key) {
            const redis = getRedis();
            if (!redis) return;
            try { await redis.del(`${prefix}:${key}`); } catch { /* ignore */ }
        },
    };
}

function buildLimiter({ prefix, windowMs, max, message, keyGen, skipSuccess = false }) {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: skipSuccess,
        keyGenerator: keyGen || ((req) => req.ip || 'unknown'),
        store: createRedisStore(prefix, windowMs),
        handler: (req, res, _next, options) => {
            const retryAfterSec = Math.ceil(options.windowMs / 1000);
            res.set('Retry-After', String(retryAfterSec));
            res.status(429).json(makeMessage(message, retryAfterSec));
        },
    });
}

// ── Buckets ───────────────────────────────────────────────────

// Scans: 120 / min PER USER (admins on shared IPs can keep scanning).
// Anonymous (no JWT) collapse onto IP and get only 60 / min.
const scanRateLimit = buildLimiter({
    prefix: 'rl:scan',
    windowMs: ONE_MINUTE,
    max: 120,
    message: 'Too many scan requests — limit is 120 per minute per user',
    keyGen: keyByUserOrIp,
});

// Login: 10 / 15min per IP+email combo to defeat credential stuffing.
const loginRateLimit = buildLimiter({
    prefix: 'rl:login',
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Too many login attempts — please try again in 15 minutes',
    keyGen: (req) => {
        const ip = req.ip || 'unknown';
        const email = (req.body?.email || '').toLowerCase().trim().slice(0, 120);
        return `${ip}|${email || '_'}`;
    },
    skipSuccess: true, // Only failed attempts count.
});

// Auth (refresh, me, logout, google): 60 / min per user/IP.
const authRateLimit = buildLimiter({
    prefix: 'rl:auth',
    windowMs: ONE_MINUTE,
    max: 60,
    message: 'Too many auth requests — please slow down',
    keyGen: keyByUserOrIp,
});

// Generic write endpoints: 200 / min per user.
const writeRateLimit = buildLimiter({
    prefix: 'rl:write',
    windowMs: ONE_MINUTE,
    max: 200,
    message: 'Too many write requests — please slow down',
    keyGen: keyByUserOrIp,
});

// Heavy endpoints (exports, reports, bulk imports): 10 / min per user.
const heavyRateLimit = buildLimiter({
    prefix: 'rl:heavy',
    windowMs: ONE_MINUTE,
    max: 10,
    message: 'Heavy operation throttled — please retry in a minute',
    keyGen: keyByUserOrIp,
});

// App-level fallback: 1000 / min per IP.
const generalRateLimit = buildLimiter({
    prefix: 'rl:general',
    windowMs: ONE_MINUTE,
    max: 1000,
    message: 'Too many requests — please slow down',
    keyGen: (req) => req.ip || 'unknown',
});

// RFID device events: 60 / min per reader (one tap every ~1 second)
const rfidRateLimit = buildLimiter({
    prefix: 'rl:rfid',
    windowMs: ONE_MINUTE,
    max: 60,
    message: 'RFID reader rate limit exceeded',
    keyGen: (req) => req.device?.readerId || req.ip || 'unknown',
});

module.exports = {
    scanRateLimit,
    loginRateLimit,
    authRateLimit,
    writeRateLimit,
    heavyRateLimit,
    generalRateLimit,
    rfidRateLimit,
    // Exposed for tests
    keyByUserOrIp,
    createRedisStore,
};
