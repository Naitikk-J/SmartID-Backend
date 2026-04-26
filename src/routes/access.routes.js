const express = require('express');
const { z } = require('zod');
const Redis = require('ioredis');

const config = require('../config/env');
const prisma = require('../config/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { scanRateLimit } = require('../middleware/rateLimit');
const faceAiService = require('../services/faceAi.service');
const { emitScanEvent } = require('../sockets/scanFeed.socket');
const { createAccessQrToken, verifyAccessQrToken } = require('../services/accessQrToken.service');
const { getGeofencingSettings } = require('../services/geofencing-settings.service');

const router = express.Router();

function isEventOnlyStudent(user) {
    if (!user) return false;
    if (String(user.role || '').toUpperCase() !== 'STUDENT') return false;
    const appAccess = String(user.appAccess || '').toUpperCase();
    const userType = String(user.userType || '').toUpperCase();
    return appAccess === 'EVENT_ONLY' || userType === 'EXTERNAL_USER';
}

// Redis client with connection timeout (prevents hanging on first request)
let redis = null;
let redisInitAttempted = false;
const REDIS_OP_TIMEOUT_MS = 2000;

function getRedis() {
    if (!config.REDIS_URL) {
        return null;
    }

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

function normalizeDirection(value) {
    const normalized = String(value || '').trim().toUpperCase();
    if (normalized === 'ENTRY' || normalized === 'EXIT') return normalized;
    return null;
}

function deriveNextDirectionFromPrevious(previousScan) {
    const previousDirection = normalizeDirection(
        previousScan?.metadata?.event_type || previousScan?.metadata?.direction,
    );

    if (previousDirection === 'ENTRY') return 'EXIT';
    if (previousDirection === 'EXIT') return 'ENTRY';
    return 'ENTRY';
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
    const geofencingSettings = getGeofencingSettings();
    const configs = loadGateQrConfigs();
    const gateConfig = configs[gate.id] || {};
    
    // Priority: Gate-specific TTL -> Global TTL
    const ttlSeconds = gateConfig.qrTtlSeconds || geofencingSettings.accessQrTtlSeconds || 20;

    const gateGeofence = parseGeofence(gate.location);

    const qr = createAccessQrToken({
        gateId: gate.id,
        gateName: gate.name,
        createdById,
        ttlSeconds: ttlSeconds,
        geofence: gateGeofence,
    });

    return {
        token: qr.token,
        gateId: gate.id,
        gateName: gate.name,
        expiresAt: qr.expiresAt,
        ttlSeconds: ttlSeconds,
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
            if (isEventOnlyStudent(req.user)) {
                return res.status(403).json({
                    success: false,
                    error: 'This account is limited to event registration and event scanning only.',
                    code: 'EVENT_ONLY_ACCESS_RESTRICTED',
                });
            }



            const qrToken = String(req.body.qr_token || req.body.qrToken || '').trim();
            const latitude = Number(req.body.latitude);
            const longitude = Number(req.body.longitude);
            const accuracy = Number(req.body.accuracy);
            const timestamp = req.body.timestamp ? new Date(req.body.timestamp) : new Date();
            const requestedEventType = normalizeDirection(req.body.event_type) || 'ENTRY';
            const mockLocation = Boolean(req.body.mock_location || req.body.mockLocation);
            const faceImage = req.body.faceImage;

            if (mockLocation) {
                return res.status(400).json({
                    success: false,
                    error: 'Mock location detected',
                    code: 'MOCK_LOCATION_BLOCKED',
                });
            }

            let qrPayload = null;
            let qrSource = 'STATELESS';
            const statelessToken = verifyAccessQrToken(qrToken);

            if (statelessToken.valid) {
                qrPayload = {
                    gateId: statelessToken.payload.gateId,
                    gateName: statelessToken.payload.gateName,
                    geofence: statelessToken.payload.geofence || null,
                    expiresAt: statelessToken.payload.expiresAt
                        ? statelessToken.payload.expiresAt.toISOString()
                        : null,
                };
            } else if (statelessToken.format === 'stateless') {
                return res.status(400).json({
                    success: false,
                    error: 'QR expired or invalid',
                    code: 'QR_EXPIRED',
                });
            } else {
                qrSource = 'REDIS_LEGACY';
                const {
                    value: qrPayloadRaw,
                    cacheUnavailable,
                } = await safeRedisGet(`qr:dynamic:${qrToken}`);

                if (!qrPayloadRaw) {
                    if (cacheUnavailable) {
                        return res.status(400).json({
                            success: false,
                            error: 'QR expired or invalid',
                            code: 'QR_EXPIRED',
                        });
                    }

                    return res.status(400).json({
                        success: false,
                        error: 'QR expired or invalid',
                        code: 'QR_EXPIRED',
                    });
                }

                try {
                    qrPayload = JSON.parse(qrPayloadRaw);
                } catch {
                    return res.status(400).json({
                        success: false,
                        error: 'QR expired or invalid',
                        code: 'QR_EXPIRED',
                    });
                }
            }

            let gateId = String(qrPayload.gateId || req.body.gate_id || '').trim();
            let gateName = qrPayload.gateName ? String(qrPayload.gateName) : null;
            let geofence = qrPayload.geofence || null;

            if (!gateId) {
                return res.status(404).json({
                    success: false,
                    error: 'Gate not found',
                    code: 'GATE_NOT_FOUND',
                });
            }

            if (qrSource === 'REDIS_LEGACY' || !geofence || !gateName) {
                let gate;
                try {
                    gate = await withTimeout(resolveGate(gateId), 2500, 'Gate lookup');
                } catch {
                    return res.status(503).json({
                        success: false,
                        error: 'Gate lookup is taking too long. Please scan again.',
                        code: 'GATE_LOOKUP_TIMEOUT',
                    });
                }

                if (!gate) {
                    return res.status(404).json({
                        success: false,
                        error: 'Gate not found',
                        code: 'GATE_NOT_FOUND',
                    });
                }

                gateId = gate.id;
                gateName = gate.name;
                if (!geofence) {
                    geofence = parseGeofence(gate.location);
                }
            }

            let geoStatus = 'PASS';
            let failureReason = null;
            let geofenceDistanceMeters = null;
            let geofenceEffectiveRadius = null;
            let geofenceConfiguredRadius = null;
            let geofenceGpsMarginMeters = null;
            const geofencingSettings = getGeofencingSettings();

            if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(accuracy)) {
                geoStatus = 'FAIL';
                failureReason = 'GPS_MISSING';
            } else if (!geofence) {
                if (geofencingSettings.accessRequireGeofence) {
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
                geofenceConfiguredRadius = Math.round(geofence.radius);
                const gpsMargin = Math.min(150, Math.max(25, Math.round(accuracy * 1.25)));
                const safetyBuffer = 20;
                const effectiveRadius = geofence.radius + gpsMargin + safetyBuffer;
                geofenceDistanceMeters = Math.round(distance);
                geofenceEffectiveRadius = Math.round(effectiveRadius);
                geofenceGpsMarginMeters = gpsMargin;

                if (distance > effectiveRadius) {
                    geoStatus = 'FAIL';
                    failureReason = 'OUTSIDE_GEOFENCE';
                }
            }

            let previous = null;
            try {
                previous = await withTimeout(
                    prisma.scanEvent.findFirst({
                        where: {
                            scannedById: req.user.id,
                            scanType: 'ACCESS_SCAN',
                        },
                        orderBy: { scannedAt: 'desc' },
                    }),
                    1200,
                    'Previous scan lookup',
                );
            } catch (err) {
                console.warn('Previous scan lookup skipped:', err.message);
            }

            // Direction is always server-derived so students cannot manually flip ENTRY/EXIT.
            const eventType = deriveNextDirectionFromPrevious(previous);

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
            const geofenceOutsideByMeters = Number.isFinite(geofenceDistanceMeters) && Number.isFinite(geofenceEffectiveRadius)
                ? Math.max(0, geofenceDistanceMeters - geofenceEffectiveRadius)
                : null;
            const resultMessage = overallPass
                ? 'Access granted'
                : failureReason === 'OUTSIDE_GEOFENCE' && Number.isFinite(geofenceOutsideByMeters)
                    ? `Outside geofence by ${geofenceOutsideByMeters}m. Ask admin to update gate geofence from Hosteller page.`
                    : (failureReason || 'Access denied');

            const configs = loadGateQrConfigs();
            const gateConfig = configs[gateId] || { validInCampus: true, validInHostel: true };

            if (gateConfig.validInCampus === false && gateConfig.validInHostel === false) {
                return res.status(403).json({ success: false, error: 'This gate is not active for campus or hostel scans.' });
            }

            let finalScanType = 'ACCESS_SCAN';
            if (gateConfig.validInCampus === false && gateConfig.validInHostel === true) {
                finalScanType = eventType === 'EXIT' ? 'GATE_EXIT' : 'GATE_ENTRY';
            }

            let scanEvent = null;
            try {
                scanEvent = await withTimeout(
                    prisma.scanEvent.create({
                        data: {
                            scannedById: req.user.id,
                            studentId: req.user.role === 'STUDENT' ? req.user.id : undefined,
                            scanType: finalScanType,
                            result: resultCode,
                            gpsLat: latitude,
                            gpsLng: longitude,
                            gateId,
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
                                requested_event_type: requestedEventType,
                                student_name: req.user.email,
                                qr_source: qrSource,
                                geofence_required: geofencingSettings.accessRequireGeofence,
                                geofence_distance_m: geofenceDistanceMeters,
                                geofence_effective_radius_m: geofenceEffectiveRadius,
                                geofence_configured_radius_m: geofenceConfiguredRadius,
                                geofence_gps_margin_m: geofenceGpsMarginMeters,
                                geofence_outside_by_m: geofenceOutsideByMeters,
                            },
                        },
                    }),
                    2500,
                    'Scan event write',
                );
            } catch (err) {
                console.warn('Scan event write skipped:', err.message);
            }

            if (gateConfig.validInHostel !== false && overallPass && req.user.role === 'STUDENT') {
                const studentRecord = await prisma.student.findUnique({ where: { id: req.user.id }, select: { studentType: true } });
                if (studentRecord?.studentType && studentRecord.studentType.startsWith('HOSTELLER')) {
                    const exitService = require('../services/exit.service');
                    try {
                        await withTimeout(
                            exitService.recordExitEvent(req.user.id, gateId, eventType, req.user.id),
                            2500,
                            'Exit event write'
                        );
                    } catch (err) {
                        console.warn('Hostel exit event write skipped:', err.message);
                    }
                }
            }

            if (scanEvent) {
                emitScanEvent({
                    scanEvent: { ...scanEvent, gateName: gateName || null },
                    student: {
                        fullName: req.user.email,
                        enrollmentNo: 'APP_USER',
                        department: 'HOSTEL',
                    },
                    scanType: 'ACCESS_SCAN',
                    result: resultCode,
                });
            }

            return res.json({
                success: overallPass,
                data: {
                    result: resultCode,
                    badge: overallPass ? 'GREEN' : 'RED',
                    message: resultMessage,
                    gate_id: gateId,
                    gate_name: gateName || 'Unknown Gate',
                    qr_status: qrStatus,
                    geo_status: geoStatus,
                    face_status: faceStatus,
                    overall_status: overallStatus,
                    location_trust_score: locationTrustScore,
                    geofence_distance_m: geofenceDistanceMeters,
                    geofence_effective_radius_m: geofenceEffectiveRadius,
                    geofence_configured_radius_m: geofenceConfiguredRadius,
                    geofence_gps_margin_m: geofenceGpsMarginMeters,
                    geofence_outside_by_m: geofenceOutsideByMeters,
                    suspicious,
                    event_type: eventType,
                    scanEventId: scanEvent?.id || null,
                },
            });
        } catch (err) {
            next(err);
        }
    }
);

// ── Per-gate QR config file ──
const QR_CONFIG_FILE = require('path').join(__dirname, '../../data/gate-qr-config.json');

function loadGateQrConfigs() {
    try {
        if (require('fs').existsSync(QR_CONFIG_FILE)) {
            return JSON.parse(require('fs').readFileSync(QR_CONFIG_FILE, 'utf8'));
        }
    } catch { /* ignore */ }
    return {};
}

function saveGateQrConfigs(configs) {
    try {
        const dir = require('path').dirname(QR_CONFIG_FILE);
        if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true });
        require('fs').writeFileSync(QR_CONFIG_FILE, JSON.stringify(configs, null, 2), 'utf8');
    } catch (e) { console.error('Failed to save gate QR config:', e); }
}

// GET per-gate QR config
router.get(
    '/gates/:id/qr-config',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD', 'WARDEN', 'SECURITY_GUARD', 'FACULTY'),
    async (req, res, next) => {
        try {
            const configs = loadGateQrConfigs();
            const cfg = configs[req.params.id] || { qrMode: 'DYNAMIC', qrTtlSeconds: 20 };
            return res.json({ success: true, data: cfg });
        } catch (err) { next(err); }
    }
);

// PUT per-gate QR config (override from QR Manage)
router.put(
    '/gates/:id/qr-config',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD', 'WARDEN'),
    async (req, res, next) => {
        try {
            const gate = await prisma.gate.findUnique({ where: { id: req.params.id } });
            if (!gate) return res.status(404).json({ success: false, error: 'Gate not found' });

            const qrMode = ['DYNAMIC', 'STATIC'].includes(req.body.qrMode) ? req.body.qrMode : 'DYNAMIC';
            const qrTtlSeconds = Math.min(120, Math.max(10, Math.round(Number(req.body.qrTtlSeconds) || 20)));
            const validInCampus = typeof req.body.validInCampus === 'boolean' ? req.body.validInCampus : true;
            const validInHostel = typeof req.body.validInHostel === 'boolean' ? req.body.validInHostel : true;

            const configs = loadGateQrConfigs();
            configs[req.params.id] = { qrMode, qrTtlSeconds, validInCampus, validInHostel, updatedAt: new Date().toISOString() };
            saveGateQrConfigs(configs);

            return res.json({ success: true, data: configs[req.params.id] });
        } catch (err) { next(err); }
    }
);

// GET all gate QR configs at once
router.get(
    '/gates/qr-configs',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD', 'WARDEN', 'SECURITY_GUARD', 'FACULTY'),
    async (req, res, next) => {
        try {
            return res.json({ success: true, data: loadGateQrConfigs() });
        } catch (err) { next(err); }
    }
);
router.post(
    '/gates',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD', 'WARDEN'),
    async (req, res, next) => {
        try {
            const name = String(req.body.name || '').trim();
            if (!name || name.length < 2) {
                return res.status(400).json({ success: false, error: 'Gate name is required (min 2 characters)' });
            }

            const existing = await prisma.gate.findFirst({
                where: { name: { equals: name, mode: 'insensitive' } },
            });
            if (existing) {
                return res.status(409).json({ success: false, error: 'A gate with this name already exists' });
            }

            const gate = await prisma.gate.create({
                data: {
                    name,
                    isActive: true,
                },
            });

            return res.status(201).json({
                success: true,
                data: {
                    id: gate.id,
                    name: gate.name,
                    hasGeofence: false,
                },
            });
        } catch (err) {
            next(err);
        }
    }
);

// ── Rename a gate ──
router.patch(
    '/gates/:id',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD', 'WARDEN'),
    async (req, res, next) => {
        try {
            const gateId = req.params.id;
            const newName = String(req.body.name || '').trim();
            if (!newName || newName.length < 2) {
                return res.status(400).json({ success: false, error: 'New gate name is required (min 2 characters)' });
            }

            const gate = await prisma.gate.findUnique({ where: { id: gateId } });
            if (!gate) {
                return res.status(404).json({ success: false, error: 'Gate not found' });
            }

            // Check for duplicate name (exclude current gate)
            const duplicate = await prisma.gate.findFirst({
                where: {
                    name: { equals: newName, mode: 'insensitive' },
                    id: { not: gateId },
                },
            });
            if (duplicate) {
                return res.status(409).json({ success: false, error: 'Another gate with this name already exists' });
            }

            const updated = await prisma.gate.update({
                where: { id: gateId },
                data: { name: newName },
            });

            return res.json({
                success: true,
                data: {
                    id: updated.id,
                    name: updated.name,
                    hasGeofence: Boolean(parseGeofence(updated.location)),
                },
            });
        } catch (err) {
            next(err);
        }
    }
);

module.exports = router;
