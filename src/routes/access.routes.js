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
            console.warn('Redis initialization failed, QR validation will be disabled', err.message);
            redis = null;
        }
    }
    return redis;
}

const rawQrTtl = Number(config.ACCESS_QR_TTL_SECONDS);
const QR_TTL_SECONDS = Number.isFinite(rawQrTtl)
    ? Math.min(120, Math.max(15, Math.round(rawQrTtl)))
    : 30;
const ACCESS_REQUIRE_FACE = String(process.env.ACCESS_REQUIRE_FACE || 'false').toLowerCase() === 'true';
const ACCESS_REQUIRE_GEOFENCE = String(config.ACCESS_REQUIRE_GEOFENCE || 'false').toLowerCase() === 'true';

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
    if (!locationValue) return null;

    const normalize = (raw) => {
        if (!raw || typeof raw !== 'object') return null;

        const centerLat = Number(
            raw.center_lat
            ?? raw.centerLat
            ?? raw.lat
            ?? raw.latitude
            ?? raw.center?.lat
        );
        const centerLng = Number(
            raw.center_lng
            ?? raw.centerLng
            ?? raw.lng
            ?? raw.longitude
            ?? raw.center?.lng
        );
        const radius = Number(
            raw.radius
            ?? raw.radius_m
            ?? raw.radiusMeters
            ?? raw.radius_metres
            ?? raw.radius_meters
            ?? raw.gpsRadiusMetres
        );

        if (!Number.isFinite(centerLat) || !Number.isFinite(centerLng) || !Number.isFinite(radius)) {
            return null;
        }

        return {
            center_lat: centerLat,
            center_lng: centerLng,
            radius: Math.min(500, Math.max(20, radius)),
            shape: raw.shape === 'POLYGON' ? 'POLYGON' : 'CIRCLE',
            polygon: Array.isArray(raw.polygon) ? raw.polygon : [],
        };
    };

    if (typeof locationValue === 'object') {
        return normalize(locationValue);
    }

    if (typeof locationValue !== 'string') return null;
    const trimmed = locationValue.trim();
    if (!trimmed) return null;

    try {
        const parsed = JSON.parse(trimmed);
        return normalize(parsed);
    } catch {
        // Support legacy "lat,lng" string format.
        const parts = trimmed.split(',').map((value) => Number(value.trim()));
        if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
            return {
                center_lat: parts[0],
                center_lng: parts[1],
                radius: 100,
                shape: 'CIRCLE',
                polygon: [],
            };
        }
    }

    return null;
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

async function safeRedisGet(key) {
    const redisClient = getRedis();
    if (!redisClient) {
        return { value: null, cacheUnavailable: true };
    }

    try {
        const value = await withTimeout(
            redisClient.get(key),
            REDIS_OP_TIMEOUT_MS,
            'Redis GET',
        );
        return { value, cacheUnavailable: false };
    } catch (err) {
        console.warn('Redis GET failed:', err.message);
        return { value: null, cacheUnavailable: true };
    }
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

    const persisted = await safeRedisSet(
        `qr:dynamic:${token}`,
        JSON.stringify({
            gateId: gate.id,
            gateName: gate.name,
            createdById,
            expiresAt: expiresAt.toISOString(),
        }),
        QR_TTL_SECONDS,
    );

    return {
        token,
        gateId: gate.id,
        gateName: gate.name,
        expiresAt,
        ttlSeconds: QR_TTL_SECONDS,
        persisted,
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

            if (!qr.persisted) {
                return res.status(503).json({
                    success: false,
                    error: 'QR service temporarily unavailable. Please retry.',
                    code: 'QR_CACHE_UNAVAILABLE',
                });
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

            if (search) {
                where.student = {
                    OR: [
                        { fullName: { contains: search, mode: 'insensitive' } },
                        { enrollmentNo: { contains: search, mode: 'insensitive' } },
                        { email: { contains: search, mode: 'insensitive' } },
                    ],
                };
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
                    select: {
                        id: true,
                        scannedAt: true,
                        result: true,
                        gateId: true,
                        metadata: true,
                        student: {
                            select: {
                                fullName: true,
                                enrollmentNo: true,
                            },
                        },
                    },
                    orderBy: { scannedAt: 'desc' },
                    skip: (page - 1) * limit,
                    take: limit,
                }),
                prisma.scanEvent.count({ where }),
            ]);

            return res.json({
                success: true,
                data: {
                    events: events.map((event) => {
                        const metadata = event.metadata || {};
                        return {
                            id: event.id,
                            student_email: metadata.student_name || metadata.studentName || 'Unknown',
                            student_name: event.student?.fullName || 'Unknown',
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
    requireRole('SUPER_ADMIN', 'HOD', 'WARDEN', 'SECURITY_GUARD', 'FACULTY', 'STUDENT'),
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

            const {
                value: qrPayloadRaw,
                cacheUnavailable,
            } = await safeRedisGet(`qr:dynamic:${qrToken}`);

            if (!qrPayloadRaw) {
                if (cacheUnavailable) {
                    return res.status(503).json({
                        success: false,
                        error: 'QR verification temporarily unavailable. Please retry.',
                        code: 'QR_VALIDATION_UNAVAILABLE',
                    });
                }

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
            let geofenceDistanceMeters = null;
            let geofenceEffectiveRadius = null;

            if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(accuracy)) {
                geoStatus = 'FAIL';
                failureReason = 'GPS_MISSING';
            } else if (!geofence) {
                if (ACCESS_REQUIRE_GEOFENCE) {
                    geoStatus = 'FAIL';
                    failureReason = 'GEOFENCE_NOT_CONFIGURED';
                } else {
                    geoStatus = 'SKIPPED';
                }
            } else {
                const distance = haversineDistanceMeters(
                    { lat: geofence.center_lat, lng: geofence.center_lng },
                    { lat: latitude, lng: longitude },
                );
                const gpsMargin = Math.min(75, Math.max(10, accuracy));
                const effectiveRadius = geofence.radius + gpsMargin;
                geofenceDistanceMeters = Math.round(distance);
                geofenceEffectiveRadius = Math.round(effectiveRadius);

                if (distance > effectiveRadius) {
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
            const geoPassed = geoStatus === 'PASS' || geoStatus === 'SKIPPED';
            const overallPass = qrStatus === 'PASS'
                && geoPassed
                && faceStatus === 'PASS'
                && !suspicious;

            const overallStatus = overallPass ? 'SUCCESS' : 'FAIL';
            const resultCode = overallPass ? 'VERIFIED' : (failureReason || 'ACCESS_DENIED');

            const scanEvent = await prisma.scanEvent.create({
                data: {
                    scannedById: req.user.id,
                    studentId: req.user.role === 'STUDENT' ? req.user.id : undefined,
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
                        direction: eventType,
                        event_type: eventType,
                        student_name: req.user.email,
                        geofence_required: ACCESS_REQUIRE_GEOFENCE,
                        geofence_distance_m: geofenceDistanceMeters,
                        geofence_effective_radius_m: geofenceEffectiveRadius,
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
