const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const Redis = require('ioredis');
const crypto = require('crypto');

const config = require('../config/env');
const prisma = require('../config/database');

const router = express.Router();

// Redis client with connection timeout (prevents hanging on first request)
let redis = null;
let redisInitAttempted = false;
const REDIS_OP_TIMEOUT_MS = 2000;

function getRedis() {
    // If we haven't attempted to connect yet, create with timeout options
    if (!redisInitAttempted) {
        redisInitAttempted = true;
        try {
            redis = new Redis(config.REDIS_URL, {
                connectTimeout: 3000, // 3-second connection timeout
                maxRetriesPerRequest: 1,
                enableReadyCheck: false,
                enableOfflineQueue: false,
                commandTimeout: REDIS_OP_TIMEOUT_MS,
                retryStrategy: () => null,
            });
            redis.on('error', (err) => {
                console.warn('Redis error:', err.message);
            });
        } catch (err) {
            console.warn('Redis initialization failed, QR operations may be limited', err.message);
            redis = null;
        }
    }
    return redis;
}

function withTimeout(promise, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label} timed out`));
        }, timeoutMs);

        promise
            .then((value) => {
                clearTimeout(timer);
                resolve(value);
            })
            .catch((err) => {
                clearTimeout(timer);
                reject(err);
            });
    });
}

async function safeRedisSet(key, value, ttlSeconds) {
    const redisClient = getRedis();
    if (!redisClient) return false;

    try {
        await withTimeout(
            redisClient.set(key, value, 'EX', ttlSeconds),
            REDIS_OP_TIMEOUT_MS,
            'Redis SET',
        );
        return true;
    } catch (err) {
        console.warn('Redis SET failed:', err.message);
        return false;
    }
}

const rawQrTtl = Number(config.ACCESS_QR_TTL_SECONDS);
const QR_TTL_SECONDS = Number.isFinite(rawQrTtl)
    ? Math.min(120, Math.max(15, Math.round(rawQrTtl)))
    : 30;

async function resolveGate(gateRef) {
    if (!gateRef) return null;

    return prisma.gate.findFirst({
        where: {
            OR: [
                { id: gateRef },
                { name: { equals: gateRef, mode: 'insensitive' } },
            ],
        },
    });
}

router.get(
    '/generate',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD', 'WARDEN', 'SECURITY_GUARD'),
    async (req, res, next) => {
        try {
            const gateRef = String(req.query.gate_id || req.query.gateId || req.user.gateId || '').trim();
            if (!gateRef) {
                return res.status(400).json({ success: false, error: 'gate_id is required' });
            }

            const gate = await resolveGate(gateRef);
            if (!gate) {
                return res.status(404).json({ success: false, error: 'Gate not found' });
            }

            const token = crypto.randomBytes(24).toString('hex');
            const expiresAt = new Date(Date.now() + (QR_TTL_SECONDS * 1000));

            const persisted = await safeRedisSet(
                `qr:dynamic:${token}`,
                JSON.stringify({ gateId: gate.id, gateName: gate.name, expiresAt: expiresAt.toISOString() }),
                QR_TTL_SECONDS,
            );

            if (!persisted) {
                return res.status(503).json({
                    success: false,
                    error: 'QR service temporarily unavailable. Please retry.',
                    code: 'QR_CACHE_UNAVAILABLE',
                });
            }

            return res.json({
                success: true,
                data: {
                    gate_id: gate.id,
                    gate_name: gate.name,
                    qr_token: token,
                    expires_at: expiresAt.toISOString(),
                    ttl_seconds: QR_TTL_SECONDS,
                },
            });
        } catch (err) {
            next(err);
        }
    }
);

module.exports = router;
