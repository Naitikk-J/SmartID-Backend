const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');

const prisma = require('../config/database');
const { createAccessQrToken } = require('../services/accessQrToken.service');
const { getGeofencingSettings } = require('../services/geofencing-settings.service');
const { logAction } = require('../services/audit.service');
const { generalRateLimit } = require('../middleware/rateLimit');

const router = express.Router();

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

// GET /generate — Mint an HMAC-signed access QR token for a gate.
//
// Every minted token authorises someone to wave students through a
// specific gate for a short TTL. The endpoint is gate-attendant-only,
// rate-limited (gates legitimately refresh every TTL seconds, no
// faster), and audited with the gate id, requested TTL, and whether
// a geofence was attached. We never log the token value itself —
// keeping the QR secret out of the audit trail is intentional.
router.get(
    '/generate',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD', 'WARDEN', 'SECURITY_GUARD'),
    generalRateLimit,
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
            const geofencingSettings = getGeofencingSettings();

            const gateGeofence = parseGeofence(gate.location);

            const qr = createAccessQrToken({
                gateId: gate.id,
                gateName: gate.name,
                createdById: req.user.id,
                ttlSeconds: geofencingSettings.accessQrTtlSeconds,
                geofence: gateGeofence,
            });

            res.json({
                success: true,
                data: {
                    gate_id: gate.id,
                    gate_name: gate.name,
                    qr_token: qr.token,
                    expires_at: qr.expiresAt.toISOString(),
                    ttl_seconds: geofencingSettings.accessQrTtlSeconds,
                },
            });

            // Audit metadata only — token value deliberately omitted.
            logAction(req, {
                action: 'MINT_ACCESS_QR',
                entity: 'Gate',
                entityId: gate.id,
                newValue: {
                    gateName: gate.name,
                    ttlSeconds: geofencingSettings.accessQrTtlSeconds,
                    expiresAt: qr.expiresAt.toISOString(),
                    geofenceAttached: Boolean(gateGeofence),
                },
            }).catch(() => {});
        } catch (err) {
            next(err);
        }
    }
);

module.exports = router;
