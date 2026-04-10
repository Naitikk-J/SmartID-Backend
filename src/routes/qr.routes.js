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

function parseGeofence(locationValue) {
    if (!locationValue) return null;

    const normalize = (raw) => {
        if (!raw || typeof raw !== 'object') return null;

        const centerLat = Number(
            raw.center_lat
            ?? raw.centerLat
            ?? raw.lat
            ?? raw.latitude
            ?? raw.center?.lat,
        );
        const centerLng = Number(
            raw.center_lng
            ?? raw.centerLng
            ?? raw.lng
            ?? raw.longitude
            ?? raw.center?.lng,
        );
        const radius = Number(raw.radius ?? raw.radius_m ?? raw.radiusMeters);

        if (!Number.isFinite(centerLat) || !Number.isFinite(centerLng) || !Number.isFinite(radius)) {
            return null;
        }

        return {
            center_lat: centerLat,
            center_lng: centerLng,
            radius: Math.min(500, Math.max(20, radius)),
            shape: raw.shape === 'POLYGON' ? 'POLYGON' : 'CIRCLE',
        };
    };

    if (typeof locationValue === 'object') {
        return normalize(locationValue);
    }

    if (typeof locationValue !== 'string') return null;
    const trimmed = locationValue.trim();
    if (!trimmed) return null;

    try {
        return normalize(JSON.parse(trimmed));
    } catch {
        return null;
    }
}

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

            const gateGeofence = parseGeofence(gate.location);

            const qr = createAccessQrToken({
                gateId: gate.id,
                gateName: gate.name,
                createdById: req.user.id,
                ttlSeconds: QR_TTL_SECONDS,
                geofence: gateGeofence,
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
