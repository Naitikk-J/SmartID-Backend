const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const Redis = require('ioredis');

const config = require('../config/env');
const prisma = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { scanRateLimit } = require('../middleware/rateLimit');
const faceAiService = require('../services/faceAi.service');
const { emitScanEvent } = require('../sockets/scanFeed.socket');

const router = express.Router();

// Lazy-load Redis to prevent module load failures
let redis = null;
function getRedis() {
    if (!redis) {
        try {
            redis = new Redis(config.REDIS_URL);
        } catch (err) {
            console.warn('Redis connection failed, QR validation will be disabled', err.message);
            redis = null;
        }
    }
    return redis;
}

const QR_TTL_SECONDS = 10;
const ACCESS_REQUIRE_FACE = String(process.env.ACCESS_REQUIRE_FACE || 'false').toLowerCase() === 'true';

const geoSchema = z.object({
    gateId: z.string().min(1),
    center_lat: z.number(),
    center_lng: z.number(),
    radius: z.number().min(20).max(200),
    shape: z.enum(['CIRCLE', 'POLYGON']).default('CIRCLE'),
    polygon: z.array(z.object({ lat: z.number(), lng: z.number() })).optional(),
});

const accessScanSchema = z.object({
    qr_token: z.string().optional(),
    qrToken: z.string().optional(),
    latitude: z.number(),
    longitude: z.number(),
    accuracy: z.number().min(0),
    timestamp: z.string().datetime().optional(),
    mock_location: z.boolean().optional(),
    mockLocation: z.boolean().optional(),
    event_type: z.enum(['ENTRY', 'EXIT']).default('ENTRY'),
    faceImage: z.string().optional(),
    gate_id: z.string().optional(),
}).refine((payload) => Boolean(payload.qr_token || payload.qrToken), {
    message: 'qr_token is required',
});

function toRadians(value) {
    return (value * Math.PI) / 180;
}

function haversineDistanceMeters(from, to) {
    const earthRadius = 6371000;
    const dLat = toRadians(to.lat - from.lat);
    const dLng = toRadians(to.lng - from.lng);

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
        + Math.cos(toRadians(from.lat)) * Math.cos(toRadians(to.lat))
        * Math.sin(dLng / 2) * Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadius * c;
}

function parseGeofence(locationValue) {
    if (!locationValue || typeof locationValue !== 'string') return null;

    try {
        const parsed = JSON.parse(locationValue);
        if (
            typeof parsed?.center_lat === 'number'
            && typeof parsed?.center_lng === 'number'
            && typeof parsed?.radius === 'number'
        ) {
            return parsed;
        }
    } catch {
        return null;
    }

    return null;
}

async function resolveGate(gateRef) {
    if (!gateRef) return null;

    const gate = await prisma.gate.findFirst({
        where: {
            OR: [
                { id: gateRef },
                { name: { equals: gateRef, mode: 'insensitive' } },
            ],
        },
    });

    return gate;
}

async function generateGateQr(gateId, createdById) {
    const gate = await resolveGate(gateId);
    if (!gate) return null;

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + (QR_TTL_SECONDS * 1000));

    const redisClient = getRedis();
    if (redisClient) {
        await redisClient.set(
            `qr:dynamic:${token}`,
            JSON.stringify({
                gateId: gate.id,
                gateName: gate.name,
                createdById,
                expiresAt: expiresAt.toISOString(),
            }),
            'EX',
            QR_TTL_SECONDS,
        );

        return {
            token,
            gateId: gate.id,
            gateName: gate.name,
            expiresAt,
            ttlSeconds: QR_TTL_SECONDS,
        };
    }

    router.get(
        '/gates',
        authenticate,
        requireRole('SUPER_ADMIN', 'HOD', 'WARDEN', 'SECURITY_GUARD'),
        async (req, res, next) => {
            try {
                const gates = await prisma.gate.findMany({
                    orderBy: { name: 'asc' },
                    select: {
                        id: true,
                        name: true,
                        location: true,
                    },
                });

                return res.json({
                    success: true,
                    data: {
                        gates: gates.map((gate) => ({
                            id: gate.id,
                            name: gate.name,
                            hasGeofence: Boolean(parseGeofence(gate.location)),
                        })),
                    },
                });
            } catch (err) {
                next(err);
            }
        }
    );

    router.get(
        '/qr/generate',
        authenticate,
        requireRole('SUPER_ADMIN', 'HOD', 'WARDEN', 'SECURITY_GUARD'),
        async (req, res, next) => {
            try {
                const gateRef = String(req.query.gate_id || req.query.gateId || req.user.gateId || '').trim();
                if (!gateRef) {
                    return res.status(400).json({ success: false, error: 'gate_id is required' });
                }

                const qr = await generateGateQr(gateRef, req.user.id);
                if (!qr) {
                    return res.status(404).json({ success: false, error: 'Gate not found' });
                }

                return res.json({
                    success: true,
                    data: {
                        gate_id: qr.gateId,
                        gate_name: qr.gateName,
                        qr_token: qr.token,
                        expires_at: qr.expiresAt.toISOString(),
                        ttl_seconds: qr.ttlSeconds,
                    },
                });
            } catch (err) {
                next(err);
            }
        }
    );

    router.get(
        '/geofence',
        authenticate,
        requireRole('SUPER_ADMIN', 'HOD', 'WARDEN', 'SECURITY_GUARD'),
        async (req, res, next) => {
            try {
                const gateRef = String(req.query.gateId || req.query.gate_id || req.user.gateId || '').trim();
                if (!gateRef) {
                    return res.status(400).json({ success: false, error: 'gateId is required' });
                }

                const gate = await resolveGate(gateRef);
                if (!gate) {
                    return res.status(404).json({ success: false, error: 'Gate not found' });
                }

                const geofence = parseGeofence(gate.location);
                return res.json({
                    success: true,
                    data: {
                        gateId: gate.id,
                        gateName: gate.name,
                        geofence: geofence || null,
                    },
                });
            } catch (err) {
                next(err);
            }
        }
    );

    router.put(
        '/geofence',
        authenticate,
        requireRole('SUPER_ADMIN', 'HOD', 'WARDEN'),
        validate(geoSchema),
        async (req, res, next) => {
            try {
                const gate = await resolveGate(req.body.gateId);
                if (!gate) {
                    return res.status(404).json({ success: false, error: 'Gate not found' });
                }

                const payload = {
                    center_lat: req.body.center_lat,
                    center_lng: req.body.center_lng,
                    radius: req.body.radius,
                    shape: req.body.shape,
                    polygon: req.body.polygon || [],
                    updated_at: new Date().toISOString(),
                    updated_by: req.user.id,
                };

                await prisma.gate.update({
                    where: { id: gate.id },
                    data: {
                        location: JSON.stringify(payload),
                    },
                });

                return res.json({
                    success: true,
                    data: {
                        gateId: gate.id,
                        geofence: payload,
                    },
                });
            } catch (err) {
                next(err);
            }
        }
    );

    router.get(
        '/activity-logs',
        authenticate,
        requireRole('SUPER_ADMIN', 'HOD', 'WARDEN', 'SECURITY_GUARD'),
        async (req, res, next) => {
            try {
                const page = Math.max(1, Number(req.query.page || 1));
                const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
                const search = String(req.query.student || req.query.search || '').trim();
                const status = String(req.query.status || '').trim().toUpperCase();
                const date = String(req.query.date || '').trim();

                const where = {
                    scanType: 'ACCESS_SCAN',
                };

                if (status) {
                    where.result = status;
                }

                if (date) {
                    const start = new Date(date);
                    start.setHours(0, 0, 0, 0);
                    const end = new Date(date);
                    end.setHours(23, 59, 59, 999);
                    where.scannedAt = { gte: start, lte: end };
                }

                const [events, total] = await Promise.all([
                    prisma.scanEvent.findMany({
                        where,
                        orderBy: { scannedAt: 'desc' },
                        skip: (page - 1) * limit,
                        take: limit,
                    }),
                    prisma.scanEvent.count({ where }),
                ]);

                const filtered = search
                    ? events.filter((event) => {
                        const metadata = event.metadata || {};
                        const studentName = String(metadata.student_name || metadata.studentName || '').toLowerCase();
                        return studentName.includes(search.toLowerCase());
                    })
                    : events;

                return res.json({
                    success: true,
                    data: {
                        events: filtered.map((event) => {
                            const metadata = event.metadata || {};
                            return {
                                id: event.id,
                                student_name: metadata.student_name || metadata.studentName || 'Unknown',
                                event_type: metadata.event_type || 'ENTRY',
                                time: event.scannedAt,
                                gate_id: event.gateId || metadata.gate_id || 'N/A',
                                geo_status: metadata.geo_status || 'UNKNOWN',
                                face_status: metadata.face_status || 'UNKNOWN',
                                overall_status: metadata.overall_status || event.result,
                                failure_reason: metadata.failure_reason || null,
                                suspicious: Boolean(metadata.suspicious),
                                location_trust_score: Number(metadata.location_trust_score || 0),
                            };
                        }),
                        total,
                        page,
                        limit,
                        pages: Math.ceil(total / limit),
                    },
                });
            } catch (err) {
                next(err);
            }
        }
    );

    router.post(
        '/scan',
        authenticate,
        requireRole('SUPER_ADMIN', 'HOD', 'WARDEN', 'SECURITY_GUARD', 'FACULTY'),
        scanRateLimit,
        validate(accessScanSchema),
        async (req, res, next) => {
            try {
                const qrToken = String(req.body.qr_token || req.body.qrToken || '').trim();
                const latitude = Number(req.body.latitude);
                const longitude = Number(req.body.longitude);
                const accuracy = Number(req.body.accuracy);
                const timestamp = req.body.timestamp ? new Date(req.body.timestamp) : new Date();
                const eventType = String(req.body.event_type || 'ENTRY').toUpperCase();
                const mockLocation = Boolean(req.body.mock_location || req.body.mockLocation);
                const faceImage = req.body.faceImage;

                if (mockLocation) {
                    return res.status(400).json({
                        success: false,
                        error: 'Mock location detected',
                        code: 'MOCK_LOCATION_BLOCKED',
                    });
                }

                const redisClient = getRedis();
                const qrPayloadRaw = redisClient ? await redisClient.get(`qr:dynamic:${qrToken}`) : null;
                if (!qrPayloadRaw) {
                    return res.status(400).json({
                        success: false,
                        error: 'QR expired or invalid',
                        code: 'QR_EXPIRED',
                    });
                }

                const qrPayload = JSON.parse(qrPayloadRaw);
                const gate = await resolveGate(qrPayload.gateId || req.body.gate_id);
                if (!gate) {
                    return res.status(404).json({
                        success: false,
                        error: 'Gate not found',
                        code: 'GATE_NOT_FOUND',
                    });
                }

                const geofence = parseGeofence(gate.location);
                let geoStatus = 'PASS';
                let failureReason = null;

                if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(accuracy)) {
                    geoStatus = 'FAIL';
                    failureReason = 'GPS_MISSING';
                } else if (!geofence) {
                    geoStatus = 'FAIL';
                    failureReason = 'GEOFENCE_NOT_CONFIGURED';
                } else {
                    const distance = haversineDistanceMeters(
                        { lat: geofence.center_lat, lng: geofence.center_lng },
                        { lat: latitude, lng: longitude },
                    );
                    if (distance > geofence.radius) {
                        geoStatus = 'FAIL';
                        failureReason = 'OUTSIDE_GEOFENCE';
                    }
                }

                const previous = await prisma.scanEvent.findFirst({
                    where: {
                        scannedById: req.user.id,
                        scanType: 'ACCESS_SCAN',
                    },
                    orderBy: { scannedAt: 'desc' },
                });

                let suspicious = false;
                let locationTrustScore = 100;
                if (previous?.metadata?.latitude && previous?.metadata?.longitude && previous?.scannedAt) {
                    const prevLat = Number(previous.metadata.latitude);
                    const prevLng = Number(previous.metadata.longitude);
                    const travelDistance = haversineDistanceMeters(
                        { lat: prevLat, lng: prevLng },
                        { lat: latitude, lng: longitude },
                    );
                    const dtSec = Math.max(1, Math.abs((timestamp.getTime() - new Date(previous.scannedAt).getTime()) / 1000));

                    if (travelDistance > 1000 && dtSec <= 5) {
                        suspicious = true;
                        locationTrustScore = 20;
                    } else if (travelDistance > 300 && dtSec <= 5) {
                        suspicious = true;
                        locationTrustScore = 40;
                    }
                }

                let faceStatus = 'PASS';
                if (ACCESS_REQUIRE_FACE || faceImage) {
                    if (!faceImage) {
                        faceStatus = 'FAIL';
                        if (!failureReason) failureReason = 'FACE_FAIL';
                    } else {
                        try {
                            const extraction = await faceAiService.extractDescriptor(faceImage, `access-${req.user.id}`);
                            const hasTrackedFace = Array.isArray(extraction?.trackedFaces)
                                && extraction.trackedFaces.some((face) => Array.isArray(face?.bbox) && face.bbox.length >= 4);
                            if (!hasTrackedFace || extraction?.isLive === false) {
                                faceStatus = 'FAIL';
                                if (!failureReason) failureReason = 'FACE_FAIL';
                            }
                        } catch {
                            faceStatus = 'FAIL';
                            if (!failureReason) failureReason = 'FACE_FAIL';
                        }
                    }
                }

                const qrStatus = 'PASS';
                const overallPass = qrStatus === 'PASS'
                    && geoStatus === 'PASS'
                    && faceStatus === 'PASS'
                    && !suspicious;

                const overallStatus = overallPass ? 'SUCCESS' : 'FAIL';
                const resultCode = overallPass ? 'VERIFIED' : (failureReason || 'ACCESS_DENIED');

                const scanEvent = await prisma.scanEvent.create({
                    data: {
                        scannedById: req.user.id,
                        scanType: 'ACCESS_SCAN',
                        result: resultCode,
                        gpsLat: latitude,
                        gpsLng: longitude,
                        gateId: gate.id,
                        scannedAt: timestamp,
                        metadata: {
                            qr_token: qrToken,
                            qr_status: qrStatus,
                            geo_status: geoStatus,
                            face_status: faceStatus,
                            overall_status: overallStatus,
                            failure_reason: failureReason,
                            suspicious,
                            location_trust_score: locationTrustScore,
                            latitude,
                            longitude,
                            accuracy,
                            event_type: eventType,
                            student_name: req.user.email,
                        },
                    },
                });

                emitScanEvent({
                    scanEvent,
                    student: {
                        fullName: req.user.email,
                        enrollmentNo: 'APP_USER',
                        department: 'HOSTEL',
                    },
                    scanType: 'ACCESS_SCAN',
                    result: resultCode,
                });

                return res.json({
                    success: overallPass,
                    data: {
                        result: resultCode,
                        badge: overallPass ? 'GREEN' : 'RED',
                        message: overallPass ? 'Access granted' : (failureReason || 'Access denied'),
                        gate_id: gate.id,
                        gate_name: gate.name,
                        qr_status: qrStatus,
                        geo_status: geoStatus,
                        face_status: faceStatus,
                        overall_status: overallStatus,
                        location_trust_score: locationTrustScore,
                        suspicious,
                        scanEventId: scanEvent.id,
                    },
                });
            } catch (err) {
                next(err);
            }
        }
    );

    module.exports = router;
