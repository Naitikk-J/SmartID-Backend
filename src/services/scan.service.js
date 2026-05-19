// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Core Scan Service
// The central verification engine for all QR code scans
// ═══════════════════════════════════════════════════════════════

const prisma = require('../config/database');
const { decryptToken } = require('./crypto.service');
const exitService = require('./exit.service');
const attendanceService = require('./attendance.service');
const { emitScanEvent } = require('../sockets/scanFeed.socket');
const logger = require('../config/logger');
const { getGeofencingSettings } = require('./geofencing-settings.service');
const { withLock } = require('../utils/locks');
const { csvRow } = require('../utils/csv');
const { safeContains } = require('../utils/search');
const { parsePagination } = require('../utils/pagination');

function haversineDistance(lat1, lng1, lat2, lng2) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return 6371000 * c; // Earth radius in metres
}

/**
 * Resolve which meal-slot bucket a timestamp falls into. Exported for tests.
 *  - BREAKFAST: 06:00–10:00
 *  - LUNCH:     11:00–15:00
 *  - SNACKS:    16:00–17:00
 *  - DINNER:    18:00–22:00
 *  - OTHER:     anything else (whole-day bucket)
 */
function resolveMealSlot(at = new Date()) {
    const hour = at.getHours();
    let slot;
    if (hour >= 6 && hour < 10) slot = 'BREAKFAST';
    else if (hour >= 11 && hour < 15) slot = 'LUNCH';
    else if (hour >= 16 && hour < 17) slot = 'SNACKS';
    else if (hour >= 18 && hour < 22) slot = 'DINNER';
    else slot = 'OTHER';

    const start = new Date(at);
    const end = new Date(at);
    if (slot === 'BREAKFAST') { start.setHours(6, 0, 0, 0); end.setHours(10, 0, 0, 0); }
    else if (slot === 'LUNCH') { start.setHours(11, 0, 0, 0); end.setHours(15, 0, 0, 0); }
    else if (slot === 'SNACKS') { start.setHours(16, 0, 0, 0); end.setHours(17, 0, 0, 0); }
    else if (slot === 'DINNER') { start.setHours(18, 0, 0, 0); end.setHours(22, 0, 0, 0); }
    else { start.setHours(0, 0, 0, 0); end.setHours(23, 59, 59, 999); }
    return { slot, start, end };
}

function checkGeofence(gpsLat, gpsLng, centerLat, centerLng, radiusMetres) {
    if (gpsLat == null || gpsLng == null) {
        // GPS disabled — do NOT silently allow. Require location for campus scans.
        return { inside: false, distance: null, reason: 'GPS location required but not provided' };
    }
    const distance = haversineDistance(parseFloat(gpsLat), parseFloat(gpsLng), centerLat, centerLng);
    return { inside: distance <= radiusMetres, distance: Math.round(distance) };
}

// Badge colour mapping
const BADGE_MAP = {
    VERIFIED: 'GREEN',
    FAKE: 'RED',
    LOST: 'AMBER',
    INACTIVE: 'GREY',
    DENIED: 'RED',
    GPS_FAIL: 'RED',
    LIMIT_HIT: 'RED',
    DUPLICATE: 'AMBER',
    TIME_EXPIRED: 'RED',
    ALREADY_VOTED: 'AMBER',
    ALREADY_ENTERED: 'AMBER',
};

function resolveDirectionFromScanEvent(scanEvent) {
    const metadataDirection = scanEvent?.metadata?.direction;
    if (metadataDirection === 'ENTRY' || metadataDirection === 'EXIT') {
        return metadataDirection;
    }

    const metadataEventType = scanEvent?.metadata?.event_type;
    if (metadataEventType === 'ENTRY' || metadataEventType === 'EXIT') {
        return metadataEventType;
    }

    if (scanEvent?.scanType === 'GATE_ENTRY') return 'ENTRY';
    if (scanEvent?.scanType === 'GATE_EXIT') return 'EXIT';
    return null;
}

/**
 * Verify a QR scan and process the operation.
 * This is the most critical function in the entire system.
 */
async function verifyScan({ rawToken, gpsLat, gpsLng, scanType, operatorId, gateId, metadata = {} }) {
    try {
        // ─────────────────────────────────────────────────────────
        // Step 1: Decrypt the QR token
        // ─────────────────────────────────────────────────────────
        let decryptedPayload;
        try {
            decryptedPayload = decryptToken(rawToken);
        } catch (err) {
            const errorMsg = err?.message || 'Decryption failed';
            logger.warn('FAKE scan attempt — decryption failed', {
                rawToken: rawToken?.substring(0, 20),
                error: errorMsg
            });
            const fakeEvent = await logScanEvent({
                studentId: null,
                cardId: null,
                scannedById: operatorId,
                scanType: 'FAKE_ATTEMPT',
                gateId,
                gpsLat,
                gpsLng,
                result: 'FAKE',
                metadata: { reason: errorMsg },
            });
            return buildResult('FAKE', null, fakeEvent, { message: 'Invalid or tampered QR code' });
        }

        // ─────────────────────────────────────────────────────────
        // Step 2: Look up the card and student
        // ─────────────────────────────────────────────────────────
        let card;
        if (decryptedPayload && decryptedPayload.type === 'DYNAMIC_ID') {
            // Check dynamic token freshness (30 seconds window)
            const MAX_AGE = 30000;
            const age = Date.now() - decryptedPayload.ts;
            
            if (age < -5000 || age > MAX_AGE) { // Allow 5s clock drift backwards
                const fakeEvent = await logScanEvent({
                    studentId: decryptedPayload.studentId,
                    cardId: decryptedPayload.cardId,
                    scannedById: operatorId,
                    scanType: 'FAKE_ATTEMPT',
                    gateId,
                    gpsLat,
                    gpsLng,
                    result: 'TIME_EXPIRED',
                    metadata: { reason: 'Dynamic token expired', age },
                });
                return buildResult('TIME_EXPIRED', null, fakeEvent, { message: 'QR code expired. Please refresh.' });
            }

            card = await prisma.card.findUnique({
                where: { id: decryptedPayload.cardId },
                include: { student: true },
            });

            // Security check: Payload studentId must match card studentId
            if (card && card.studentId !== decryptedPayload.studentId) {
                 return buildResult('FAKE', null, null, { message: 'Token ownership mismatch' });
            }
        } else {
            // Fallback to legacy static token lookup
            card = await prisma.card.findUnique({
                where: { qrToken: rawToken },
                include: { student: true },
            });
        }

        if (!card) {
            const fakeEvent = await logScanEvent({
                studentId: null,
                cardId: null,
                scannedById: operatorId,
                scanType: 'FAKE_ATTEMPT',
                gateId,
                gpsLat,
                gpsLng,
                result: 'FAKE',
                metadata: { reason: 'Card not found in database' },
            });
            return buildResult('FAKE', null, fakeEvent);
        }

        const student = card.student;

        // ─────────────────────────────────────────────────────────
        // Step 2.5: Common state for gates/mess
        // ─────────────────────────────────────────────────────────
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        // Card status checks
        if (card.status === 'LOST') {
            const event = await logScanEvent({
                studentId: student.id,
                cardId: card.id,
                scannedById: operatorId,
                scanType,
                gateId,
                gpsLat,
                gpsLng,
                result: 'LOST',
            });
            return buildResult('LOST', student, event);
        }

        if (card.status === 'INACTIVE' || card.status === 'REPLACED') {
            const event = await logScanEvent({
                studentId: student.id,
                cardId: card.id,
                scannedById: operatorId,
                scanType,
                gateId,
                gpsLat,
                gpsLng,
                result: 'INACTIVE',
            });
            return buildResult('INACTIVE', student, event);
        }

        if (!student.isActive) {
            const event = await logScanEvent({
                studentId: student.id,
                cardId: card.id,
                scannedById: operatorId,
                scanType,
                gateId,
                gpsLat,
                gpsLng,
                result: 'INACTIVE',
            });
            return buildResult('INACTIVE', student, event);
        }

        // ─────────────────────────────────────────────────────────
        // Step 2.6: Geofencing check for ALL scan types
        // ─────────────────────────────────────────────────────────
        const geofencingSettings = getGeofencingSettings();
        const geofenceResult = checkGeofence(
            gpsLat,
            gpsLng,
            geofencingSettings.campusCenterLat,
            geofencingSettings.campusCenterLng,
            geofencingSettings.campusRadiusMetres,
        );
        if (!geofenceResult.inside) {
            const event = await logScanEvent({
                studentId: student.id,
                cardId: card.id,
                scannedById: operatorId,
                scanType,
                gateId,
                gpsLat,
                gpsLng,
                result: 'GPS_FAIL',
                metadata: {
                    reason: 'Outside campus geofence',
                    distance: geofenceResult.distance,
                    campusRadius: geofencingSettings.campusRadiusMetres,
                },
            });
            return buildResult('GPS_FAIL', student, event, {
                message: `Geofencing failed: ${geofenceResult.distance}m from campus (max ${geofencingSettings.campusRadiusMetres}m)`,
            });
        }

        // ─────────────────────────────────────────────────────────
        // Step 3: Scan-type branching
        // ─────────────────────────────────────────────────────────
        let exitInfo = {};

        switch (scanType) {
            case 'GATE_EXIT': {
                const exitCheck = await exitService.checkExitAllowed(student, gateId);
                if (!exitCheck.allowed) {
                    const event = await logScanEvent({
                        studentId: student.id,
                        cardId: card.id,
                        scannedById: operatorId,
                        scanType,
                        gateId,
                        gpsLat,
                        gpsLng,
                        result: 'LIMIT_HIT',
                        metadata: { used: exitCheck.used, max: exitCheck.max, mode: exitCheck.mode },
                    });
                    return buildResult('LIMIT_HIT', student, event, {
                        exitsUsedToday: exitCheck.used,
                        exitsAllowedToday: exitCheck.max,
                        message: exitCheck.reason,
                    });
                }
                await exitService.recordExitEvent(student.id, gateId, 'EXIT', operatorId);
                exitInfo = { exitsUsedToday: exitCheck.used + 1, exitsAllowedToday: exitCheck.max };
                break;
            }

            case 'GATE_ENTRY': {
                // Coordinate concurrent entries (two scanners hitting the same
                // student in the same second) with a short Redis lock. Falls
                // through unlocked if Redis is down — we still rely on the
                // ALREADY_ENTERED check below, which closes 99% of the gap.
                const lockKey = `scan:gate-entry:${student.id}`;
                const earlyResult = await withLock(
                    lockKey,
                    3000,
                    async () => runGateEntry(),
                    async () => runGateEntry(), // best-effort fall-through
                );
                if (earlyResult) return earlyResult;

                async function runGateEntry() {
                    const lastEvent = await prisma.exitEvent.findFirst({
                        where: { studentId: student.id, eventTime: { gte: todayStart } },
                        orderBy: { eventTime: 'desc' },
                    });

                    if (lastEvent && lastEvent.direction === 'ENTRY') {
                        const event = await logScanEvent({
                            studentId: student.id,
                            cardId: card.id,
                            scannedById: operatorId,
                            scanType,
                            gateId,
                            gpsLat,
                            gpsLng,
                            result: 'ALREADY_ENTERED',
                        });
                        return buildResult('ALREADY_ENTERED', student, event, {
                            message: 'Student already entered. Need exit record?',
                        });
                    }

                    const entryCount = await exitService.countEntriesToday(student.id, todayStart);
                    await exitService.recordExitEvent(student.id, gateId, 'ENTRY', operatorId);

                    if (entryCount > 0) {
                        const reentryResult = `REENTERED_${entryCount + 1}`;
                        const scanEvent = await logScanEvent({
                            studentId: student.id,
                            cardId: card.id,
                            scannedById: operatorId,
                            scanType,
                            gateId,
                            gpsLat,
                            gpsLng,
                            result: reentryResult,
                        });
                        const built = buildResult(reentryResult, student, scanEvent);
                        emitScanEvent({ scanEvent, student, scanType, result: reentryResult });
                        return built;
                    }
                    return null;
                }
                break;
            }

            case 'ATTENDANCE': {
                try {
                    let sessionId = metadata?.sessionId;
                    let sessionObj = null;

                    // If no sessionId, find active session for this faculty (operatorId)
                    if (!sessionId) {
                        const activeSession = await prisma.attendanceSession.findFirst({
                            where: {
                                facultyId: operatorId,
                                status: 'OPEN',
                            },
                            orderBy: { startedAt: 'desc' },
                            include: { subject: true }
                        });

                        if (!activeSession) {
                            return buildResult('DENIED', student, null, {
                                message: 'No active session found. Please start a session in the dashboard first.',
                            });
                        }
                        sessionId = activeSession.id;
                        sessionObj = activeSession;
                    } else {
                        sessionObj = await prisma.attendanceSession.findUnique({
                            where: { id: sessionId },
                            include: { subject: true }
                        });
                    }

                    const record = await attendanceService.markAttendance({
                        sessionId,
                        studentId: student.id,
                        gpsLat,
                        gpsLng,
                    });

                    const event = await logScanEvent({
                        studentId: student.id,
                        cardId: card.id,
                        scannedById: operatorId,
                        scanType,
                        gateId,
                        gpsLat,
                        gpsLng,
                        result: 'VERIFIED',
                        metadata: { sessionId },
                    });

                    const { sendPush } = require('./notification.service');
                    const subjectName = sessionObj?.subject?.name || 'Class';
                    sendPush({
                        studentId: student.id,
                        title: 'Attendance Marked',
                        body: `Attendance marked for ${subjectName}.`,
                        data: { type: 'ATTENDANCE_MARKED', sessionId }
                    }).catch(console.error);

                    return buildResult('VERIFIED', student, event, {
                        message: `Attendance marked: ${record.student.fullName}`,
                        sessionId,
                    });
                } catch (err) {
                    const resultCode = err?.code || 'DENIED';
                    const errorMsg = err?.message || 'Attendance marking failed';
                    const event = await logScanEvent({
                        studentId: student.id,
                        cardId: card.id,
                        scannedById: operatorId,
                        scanType,
                        gateId,
                        gpsLat,
                        gpsLng,
                        result: resultCode,
                        metadata: { sessionId: metadata?.sessionId, error: errorMsg },
                    });
                    return buildResult(resultCode, student, event, { message: errorMsg });
                }
            }

            case 'MESS': {
                const { slot: mealSlot, start: slotStart, end: slotEnd } = resolveMealSlot(new Date());

                // Lock per student+meal-slot for 5s so two queues can't both
                // pass through the duplicate check. Best-effort fall-through
                // when Redis is unavailable (duplicate check still catches
                // most cases — only sub-second concurrent scans escape).
                const messLockKey = `scan:mess:${student.id}:${mealSlot}`;
                const messResult = await withLock(
                    messLockKey,
                    5000,
                    () => runMessCheck(),
                    () => runMessCheck(),
                );
                if (messResult) return messResult;

                async function runMessCheck() {
                    const messCount = await prisma.scanEvent.count({
                        where: {
                            studentId: student.id,
                            scanType: 'MESS',
                            result: 'VERIFIED',
                            scannedAt: { gte: slotStart, lte: slotEnd },
                        },
                    });

                    if (messCount > 0) {
                        const event = await logScanEvent({
                            studentId: student.id,
                            cardId: card.id,
                            scannedById: operatorId,
                            scanType,
                            gateId,
                            gpsLat,
                            gpsLng,
                            result: 'DUPLICATE',
                            metadata: { mealSlot },
                        });
                        return buildResult('DUPLICATE', student, event, {
                            message: `Already scanned for ${mealSlot.toLowerCase()} today`,
                        });
                    }
                    return null;
                }

                metadata.mealSlot = mealSlot;
                break;
            }

            case 'VOTE_CAST': {
                if (!metadata.electionId || !metadata.candidate) {
                    const event = await logScanEvent({
                        studentId: student.id,
                        cardId: card.id,
                        scannedById: operatorId,
                        scanType,
                        gateId,
                        gpsLat,
                        gpsLng,
                        result: 'DENIED',
                        metadata: { reason: 'Missing electionId or candidate' },
                    });
                    return buildResult('DENIED', student, event, { message: 'Election ID and candidate required' });
                }

                // Check if already voted
                const existingVote = await prisma.vote.findUnique({
                    where: {
                        electionId_studentId: {
                            electionId: metadata.electionId,
                            studentId: student.id,
                        },
                    },
                });

                if (existingVote) {
                    const event = await logScanEvent({
                        studentId: student.id,
                        cardId: card.id,
                        scannedById: operatorId,
                        scanType,
                        gateId,
                        gpsLat,
                        gpsLng,
                        result: 'ALREADY_VOTED',
                    });
                    return buildResult('ALREADY_VOTED', student, event);
                }

                // Cast vote
                await prisma.vote.create({
                    data: {
                        electionId: metadata.electionId,
                        studentId: student.id,
                        candidate: metadata.candidate,
                    },
                });
                break;
            }

            default:
                // All other scan types (LIBRARY_ISSUE, LIBRARY_RETURN, CANTEEN_PAYMENT, etc.)
                break;
        }

        // ─────────────────────────────────────────────────────────
        // Step 4: Log the scan event
        // ─────────────────────────────────────────────────────────
        const scanEvent = await logScanEvent({
            studentId: student.id,
            cardId: card.id,
            scannedById: operatorId,
            scanType,
            gateId,
            gpsLat,
            gpsLng,
            result: 'VERIFIED',
            metadata,
        });

        // ─────────────────────────────────────────────────────────
        // Step 6: Return result (Priority)
        // ─────────────────────────────────────────────────────────
        const result = buildResult('VERIFIED', student, scanEvent, exitInfo);

        // ─────────────────────────────────────────────────────────
        // Step 5: Emit real-time event to dashboard (Background)
        // ─────────────────────────────────────────────────────────
        // We do this just before returning but technically it's fine here
        emitScanEvent({ scanEvent, student, scanType, result: 'VERIFIED' });

        return result;

    } catch (err) {
        logger.error('CRITICAL scan failure:', { error: err?.message, stack: err?.stack });
        return {
            result: 'ERROR',
            badge: 'RED',
            student: null,
            message: 'Internal server error processing scan',
        };
    }
}

// ── Helpers ──────────────────────────────────────────────────

async function logScanEvent({ studentId, cardId, scannedById, scanType, gateId, gpsLat, gpsLng, result, metadata = {} }) {
    const data = {
        scannedById,
        scanType,
        result,
        gpsLat: gpsLat != null ? parseFloat(gpsLat) : null,
        gpsLng: gpsLng != null ? parseFloat(gpsLng) : null,
        metadata,
    };

    // Only set foreign keys if they are valid
    if (studentId) data.studentId = studentId;
    if (cardId) data.cardId = cardId;
    if (gateId) data.gateId = gateId;

    return prisma.scanEvent.create({ data });
}

/**
 * Calculate distance between two GPS coordinates using Haversine formula
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000; // Earth radius in meters
    const toRad = (deg) => (deg * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

/**
 * Validate geofencing for scan location
 */
function validateGeofence(gpsLat, gpsLng, allowedLocations = []) {
    if (!gpsLat || !gpsLng) {
        return { valid: true, message: 'No GPS data provided' };
    }

    const lat = parseFloat(gpsLat);
    const lng = parseFloat(gpsLng);

    if (isNaN(lat) || isNaN(lng)) {
        return { valid: false, message: 'Invalid GPS coordinates' };
    }

    // If no geofencing configured, allow
    if (!allowedLocations || allowedLocations.length === 0) {
        return { valid: true, message: 'Geofencing not configured' };
    }

    for (const location of allowedLocations) {
        const distance = calculateDistance(
            lat,
            lng,
            parseFloat(location.lat),
            parseFloat(location.lng)
        );

        if (distance <= (location.radius || 100)) {
            return {
                valid: true,
                message: `Within range: ${Math.round(distance)}m from ${location.name}`,
                distance,
                locationName: location.name,
            };
        }
    }

    return { valid: false, message: 'GPS check failed: Outside allowed location' };
}

function buildResult(result, student, scanEvent, extra = {}) {
    const safeExtra = extra || {};
    const isReentry = result.startsWith('REENTERED_');
    const badgeCode = isReentry ? 'GREEN' : (BADGE_MAP[result] || 'GREY');

    return {
        result,
        badge: badgeCode,
        student: student
            ? {
                id: student.id,
                fullName: student.fullName,
                enrollmentNo: student.enrollmentNo,
                email: student.email,
                photoUrl: student.photoUrl,
                department: student.department,
                year: student.year,
                section: student.section,
                bloodGroup: student.bloodGroup,
                studentType: student.studentType,
                userType: student.userType,
            }
            : null,
        scanEventId: scanEvent?.id?.toString(),
        scannedAt: scanEvent?.scannedAt,
        message: safeExtra.message || result,
        ...safeExtra,
    };
}

/**
 * Get recent scans for the dashboard live feed.
 */
async function getRecentScans({ date, page = 1, limit = 50, direction, search, studentType, since }) {
    try {
        const { page: safePage, limit: safeLimit, skip } = parsePagination(
            { page, limit },
            { maxLimit: 200 },
        );
        const where = {};

        if (date) {
            const start = new Date(date);
            start.setHours(0, 0, 0, 0);
            const end = new Date(date);
            end.setHours(23, 59, 59, 999);
            where.scannedAt = { gte: start, lte: end };
        }

        // Incremental polling cursor — admin UI passes the timestamp of
        // the newest event it already has and gets only the strictly
        // newer ones. Survives Vercel WebSocket gaps and brief network
        // hiccups without duplicate rows.
        if (since) {
            const sinceDate = since instanceof Date ? since : new Date(since);
            if (!Number.isNaN(sinceDate.getTime())) {
                where.scannedAt = where.scannedAt
                    ? { ...where.scannedAt, gt: sinceDate }
                    : { gt: sinceDate };
            }
        }

        if (direction && ['ENTRY', 'EXIT'].includes(String(direction).toUpperCase())) {
            where.scanType = String(direction).toUpperCase() === 'ENTRY' ? 'GATE_ENTRY' : 'GATE_EXIT';
        }

        const normalizedStudentType = String(studentType || '').toUpperCase();
        if (normalizedStudentType === 'HOSTELLER') {
            where.student = {
                studentType: { in: ['HOSTELLER_BOYS', 'HOSTELLER_GIRLS'] },
            };
        } else if (['HOSTELLER_BOYS', 'HOSTELLER_GIRLS', 'DAY_SCHOLAR'].includes(normalizedStudentType)) {
            where.student = {
                studentType: normalizedStudentType,
            };
        }

        // Regex-escape user-supplied search term to neutralise NoSQL
        // injection / ReDoS via the Prisma `contains` -> $regex bridge.
        const term = safeContains(search);
        if (term) {
            where.student = {
                ...(where.student || {}),
                OR: [
                    { fullName: { contains: term, mode: 'insensitive' } },
                    { enrollmentNo: { contains: term, mode: 'insensitive' } },
                ],
            };
        }

        const [events, total] = await Promise.all([
            prisma.scanEvent.findMany({
                where,
                take: safeLimit,
                skip,
                orderBy: { scannedAt: 'desc' },
                include: {
                    student: {
                        select: {
                            id: true,
                            fullName: true,
                            enrollmentNo: true,
                            department: true,
                            photoUrl: true,
                            studentType: true,
                        }
                    },
                    card: {
                        select: {
                            status: true,
                        }
                    },
                    gate: {
                        select: {
                            name: true,
                        }
                    }
                }
            }),
            prisma.scanEvent.count({ where })
        ]);

        return {
            events: events.map(e => ({
                id: e.id,
                time: e.scannedAt,
                studentName: e.student?.fullName || 'Unknown',
                enrollmentNo: e.student?.enrollmentNo || 'N/A',
                studentType: e.student?.studentType || null,
                department: e.student?.department || 'N/A',
                scanType: e.scanType,
                result: e.result,
                badge: BADGE_MAP[e.result] || (e.card?.status === 'ACTIVE' ? 'GREEN' : 'GREY'),
                gateId: e.gateId,
                gateName: e.gate?.name || null,
                direction: resolveDirectionFromScanEvent(e)
            })),
            total,
            page: safePage,
            limit: safeLimit,
            pages: Math.ceil(total / safeLimit),
        };
    } catch (err) {
        logger.error('Failed to fetch recent scans:', err);
        throw err;
    }
}

/**
 * Export scans for a specific date as CSV data.
 */
async function exportScans({ date }) {
    try {
        const where = {};
        if (date) {
            const start = new Date(date);
            start.setHours(0, 0, 0, 0);
            const end = new Date(date);
            end.setHours(23, 59, 59, 999);
            where.scannedAt = { gte: start, lte: end };
        }

        const events = await prisma.scanEvent.findMany({
            where,
            orderBy: { scannedAt: 'asc' },
            include: {
                student: {
                    select: {
                        fullName: true,
                        enrollmentNo: true,
                        department: true,
                    }
                },
                card: {
                    select: {
                        status: true,
                    }
                }
            }
        });

        // Generate CSV — every cell goes through escapeCsvField to defeat
        // formula-injection (=cmd, +cmd, -cmd, @cmd) plus proper quoting.
        const headers = ['Time', 'Enrollment No', 'Student Name', 'Department', 'Scan Type', 'Direction', 'Result', 'Badge'];
        const lines = [csvRow(headers)];
        for (const e of events) {
            lines.push(csvRow([
                new Date(e.scannedAt).toLocaleTimeString([], { hour12: false }),
                e.student?.enrollmentNo || 'N/A',
                e.student?.fullName || 'Unknown',
                e.student?.department || 'N/A',
                e.scanType,
                resolveDirectionFromScanEvent(e) || 'N/A',
                e.result,
                BADGE_MAP[e.result] || (e.card?.status === 'ACTIVE' ? 'GREEN' : 'GREY'),
            ]));
        }
        return lines.join('\r\n');
    } catch (err) {
        logger.error('Failed to export scans:', err);
        throw err;
    }
}

module.exports = {
    verifyScan,
    getRecentScans,
    exportScans,
    calculateDistance,
    validateGeofence,
    buildResult,
    haversineDistance,
    checkGeofence,
    resolveMealSlot,
};
