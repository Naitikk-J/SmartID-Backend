const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const Redis = require('ioredis');
const crypto = require('crypto');

const config = require('../config/env');
const prisma = require('../config/database');

const router = express.Router();

// Lazy-load Redis to prevent module load failures
let redis = null;
function getRedis() {
    if (!redis) {
        try {
            redis = new Redis(config.REDIS_URL);
        } catch (err) {
            console.warn('Redis connection failed, QR operations may be limited', err.message);
            redis = null;
        }
    }
    return redis;
}
const QR_TTL_SECONDS = Number(config.ACCESS_QR_TTL_SECONDS || 30);

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
            const redisClient = getRedis();
            if (redisClient) {
                await redisClient.set(
                    `qr:dynamic:${token}`,
                    JSON.stringify({ gateId: gate.id, gateName: gate.name, expiresAt: expiresAt.toISOString() }),
                    'EX',
                    QR_TTL_SECONDS,
                );
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
