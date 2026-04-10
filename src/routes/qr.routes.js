const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');

const config = require('../config/env');
const prisma = require('../config/database');
const { createAccessQrToken } = require('../services/accessQrToken.service');

const router = express.Router();

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

            const qr = createAccessQrToken({
                gateId: gate.id,
                gateName: gate.name,
                createdById: req.user.id,
                ttlSeconds: QR_TTL_SECONDS,
            });

            return res.json({
                success: true,
                data: {
                    gate_id: gate.id,
                    gate_name: gate.name,
                    qr_token: qr.token,
                    expires_at: qr.expiresAt.toISOString(),
                    ttl_seconds: QR_TTL_SECONDS,
                },
            });
        } catch (err) {
            next(err);
        }
    }
);

module.exports = router;
