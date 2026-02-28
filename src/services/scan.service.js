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
};

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
        const card = await prisma.card.findUnique({
            where: { qrToken: rawToken },
            include: { student: true },
        });

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
                await exitService.recordExitEvent(student.id, gateId, 'EXIT');
                exitInfo = { exitsUsedToday: exitCheck.used + 1, exitsAllowedToday: exitCheck.max };
                break;
            }

            case 'GATE_ENTRY': {
                await exitService.recordExitEvent(student.id, gateId, 'ENTRY');
                break;
            }

            case 'ATTENDANCE': {
                try {
                    let sessionId = metadata?.sessionId;

                    // If no sessionId, find active session for this faculty (operatorId)
                    if (!sessionId) {
                        const activeSession = await prisma.attendanceSession.findFirst({
                            where: {
                                facultyId: operatorId,
                                status: 'OPEN',
                            },
                            orderBy: { startedAt: 'desc' },
                        });

                        if (!activeSession) {
                            return buildResult('DENIED', student, null, {
                                message: 'No active session found. Please start a session in the dashboard first.',
                            });
                        }
                        sessionId = activeSession.id;
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
                // Check student hasn't already scanned MESS today
                const todayStart = new Date();
                todayStart.setHours(0, 0, 0, 0);
                const todayEnd = new Date();
                todayEnd.setHours(23, 59, 59, 999);

                const messCount = await prisma.scanEvent.count({
                    where: {
                        studentId: student.id,
                        scanType: 'MESS',
                        result: 'VERIFIED',
                        scannedAt: { gte: todayStart, lte: todayEnd },
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
                    });
                    return buildResult('DUPLICATE', student, event, { message: 'Already scanned for mess today' });
                }
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
        // Step 5: Emit real-time event to dashboard
        // ─────────────────────────────────────────────────────────
        emitScanEvent({ scanEvent, student, scanType, result: 'VERIFIED' });

        // ─────────────────────────────────────────────────────────
        // Step 6: Return result
        // ─────────────────────────────────────────────────────────
        return buildResult('VERIFIED', student, scanEvent, exitInfo);

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

    // If no studentId, we need to create a "dummy" reference or handle differently
    if (!studentId) {
        // For FAKE scans without a student, we won't create a DB record with an FK
        // Instead, log it and return a synthetic event
        logger.warn('Scan event without student', { scanType, result });
        return {
            id: Date.now().toString(),
            ...data,
            scannedAt: new Date(),
        };
    }

    return prisma.scanEvent.create({ data });
}

function buildResult(result, student, scanEvent, extra = {}) {
    const safeExtra = extra || {};
    return {
        result,
        badge: BADGE_MAP[result] || 'GREY',
        student: student
            ? {
                id: student.id,
                fullName: student.fullName,
                enrollmentNo: student.enrollmentNo,
                photoUrl: student.photoUrl,
                department: student.department,
                year: student.year,
                bloodGroup: student.bloodGroup,
                studentType: student.studentType,
            }
            : null,
        scanEventId: scanEvent?.id?.toString(),
        message: safeExtra.message || result,
        ...safeExtra,
    };
}

/**
 * Get recent scans for the dashboard live feed.
 */
async function getRecentScans(limit = 50) {
    try {
        const events = await prisma.scanEvent.findMany({
            take: limit,
            orderBy: { scannedAt: 'desc' },
            include: {
                student: {
                    select: {
                        fullName: true,
                        enrollmentNo: true,
                        department: true,
                        photoUrl: true,
                    }
                },
                card: {
                    select: {
                        badge: true,
                    }
                }
            }
        });

        // Transform into the format expected by the frontend
        return events.map(e => ({
            id: e.id.toString(),
            time: e.scannedAt,
            studentName: e.student?.fullName || 'Unknown',
            enrollmentNo: e.student?.enrollmentNo || 'N/A',
            department: e.student?.department || 'N/A',
            scanType: e.scanType,
            result: e.result,
            badge: BADGE_MAP[e.result] || (e.card?.badge || 'GREY'),
            gateId: e.gateId,
        }));
    } catch (err) {
        logger.error('Failed to fetch recent scans:', err);
        throw err;
    }
}

module.exports = { verifyScan, getRecentScans };
