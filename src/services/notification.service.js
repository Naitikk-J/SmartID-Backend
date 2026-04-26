// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Notification Service
// Firebase push + cron-scheduled reminders
// ═══════════════════════════════════════════════════════════════

const prisma = require('../config/database');
const logger = require('../config/logger');

// Firebase admin — initialize lazily to avoid errors when not configured
let firebaseAdmin = null;

function getFirebaseAdmin() {
    if (!firebaseAdmin) {
        try {
            const admin = require('firebase-admin');
            const config = require('../config/env');
            if (config.FIREBASE_SERVICE_ACCOUNT_PATH) {
                const serviceAccount = require(config.FIREBASE_SERVICE_ACCOUNT_PATH);
                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount),
                });
                firebaseAdmin = admin;
            }
        } catch (err) {
            logger.warn('Firebase not configured:', err.message);
        }
    }
    return firebaseAdmin;
}

/**
 * Send a push notification to a student.
 */
async function sendPush({ studentId, title, body, data = {} }) {
    const admin = getFirebaseAdmin();
    if (!admin) {
        logger.debug('Firebase not available — skipping push notification');
        return;
    }

    const student = await prisma.student.findUnique({
        where: { id: studentId },
        select: { fcmToken: true, fullName: true },
    });

    if (!student?.fcmToken) {
        logger.debug(`No FCM token for student ${studentId} — skipping`);
        return;
    }

    try {
        await admin.messaging().send({
            token: student.fcmToken,
            notification: { title, body },
            data: { ...data, studentId: String(studentId) },
        });
        logger.info(`Push sent to student ${studentId}: ${title}`);
    } catch (err) {
        // Silently ignore — token may be invalid
        logger.warn(`Push failed for student ${studentId}:`, err.message);
    }
}

/**
 * Send overdue library reminders — runs daily at 8 AM.
 */
async function scheduleOverdueReminders() {
    const twoDaysFromNow = new Date();
    twoDaysFromNow.setDate(twoDaysFromNow.getDate() + 2);

    const dueSoon = await prisma.libraryTransaction.findMany({
        where: {
            returnedAt: null,
            dueAt: { lte: twoDaysFromNow },
        },
        include: {
            student: { select: { id: true, fullName: true } },
            book: { select: { title: true } },
        },
    });

    logger.info(`Sending ${dueSoon.length} overdue reminders`);

    for (const txn of dueSoon) {
        const isOverdue = txn.dueAt < new Date();
        await sendPush({
            studentId: txn.student.id,
            title: isOverdue ? '📚 Book Overdue!' : '📚 Book Due Soon',
            body: `"${txn.book.title}" is ${isOverdue ? 'overdue' : 'due soon'}. Please return it to the library.`,
            data: { type: 'LIBRARY_OVERDUE', bookTitle: txn.book.title },
        });
    }
}

/**
 * Send low attendance alerts — runs daily at 6 PM.
 */
async function scheduleAttendanceAlerts() {
    // Get today's sessions
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const sessions = await prisma.attendanceSession.findMany({
        where: {
            startedAt: { gte: todayStart, lte: todayEnd },
            status: 'CLOSED',
        },
        include: {
            subject: true,
            records: { select: { studentId: true } },
        },
    });

    // Find students with < 50% attendance today
    const studentAttendance = {};
    for (const session of sessions) {
        const presentIds = new Set(session.records.map((r) => r.studentId));
        // We track per-student attendance count
        for (const studentId of presentIds) {
            if (!studentAttendance[studentId]) {
                studentAttendance[studentId] = { present: 0, total: 0 };
            }
            studentAttendance[studentId].present++;
        }
    }

    // Alert students below 50%
    for (const [studentId, data] of Object.entries(studentAttendance)) {
        if (sessions.length > 0 && (data.present / sessions.length) < 0.5) {
            await sendPush({
                studentId: studentId,
                title: '⚠️ Low Attendance Today',
                body: `You attended ${data.present} of ${sessions.length} sessions today. Please improve your attendance.`,
                data: { type: 'ATTENDANCE_ALERT' },
            });
        }
    }

    logger.info(`Attendance alerts processed for ${Object.keys(studentAttendance).length} students`);
}

function parseCurfewStartOnDate(now, hhmm) {
    const [hh, mm] = String(hhmm || '21:00').split(':').map((value) => Number(value || 0));
    const date = new Date(now);
    date.setHours(hh, mm, 0, 0);
    return date;
}

function resolveDirectionFromScanEvent(scanEvent) {
    const metadataDirection = scanEvent?.metadata?.direction;
    if (metadataDirection === 'ENTRY' || metadataDirection === 'EXIT') return metadataDirection;

    const metadataEventType = scanEvent?.metadata?.event_type;
    if (metadataEventType === 'ENTRY' || metadataEventType === 'EXIT') return metadataEventType;

    if (scanEvent?.scanType === 'GATE_ENTRY') return 'ENTRY';
    if (scanEvent?.scanType === 'GATE_EXIT') return 'EXIT';
    return null;
}

async function getHostellerOutsideSnapshot(now) {
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const [scanLogs, faceLogs] = await Promise.all([
        prisma.scanEvent.findMany({
            where: {
                scannedAt: { gte: startOfDay },
                scanType: { in: ['ACCESS_SCAN', 'GATE_ENTRY', 'GATE_EXIT'] },
                student: {
                    studentType: { in: ['HOSTELLER_BOYS', 'HOSTELLER_GIRLS'] },
                },
            },
            include: {
                student: {
                    select: {
                        id: true,
                        fullName: true,
                        enrollmentNo: true,
                        studentType: true,
                    },
                },
            },
            orderBy: { scannedAt: 'desc' },
            take: 3000,
        }),
        prisma.faceDetectionLog.findMany({
            where: {
                timestamp: { gte: startOfDay },
                student: {
                    studentType: { in: ['HOSTELLER_BOYS', 'HOSTELLER_GIRLS'] },
                },
            },
            include: {
                student: {
                    select: {
                        id: true,
                        fullName: true,
                        enrollmentNo: true,
                        studentType: true,
                    },
                },
            },
            orderBy: { timestamp: 'desc' },
            take: 2000,
        }),
    ]);

    const merged = [
        ...scanLogs
            .map((event) => ({
                studentId: event.student?.id,
                student: event.student,
                direction: resolveDirectionFromScanEvent(event),
                eventTime: event.scannedAt,
                source: 'QR_SCAN',
            }))
            .filter((item) => item.studentId && (item.direction === 'ENTRY' || item.direction === 'EXIT')),
        ...faceLogs.map((event) => ({
            studentId: event.student?.id,
            student: event.student,
            direction: event.direction,
            eventTime: event.timestamp,
            source: 'HOSTELLER_FACE',
        })),
    ].sort((a, b) => new Date(b.eventTime) - new Date(a.eventTime));

    const latestByStudent = new Map();
    for (const item of merged) {
        if (!item?.studentId) continue;
        if (!latestByStudent.has(item.studentId)) {
            latestByStudent.set(item.studentId, item);
        }
    }

    return Array.from(latestByStudent.values()).filter((item) => item.direction === 'EXIT');
}

async function scheduleHostellerCurfewAlerts() {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const [rules, outsideStudents] = await Promise.all([
        prisma.curfewRule.findMany({
            where: {
                isActive: true,
                studentType: { in: ['HOSTELLER_BOYS', 'HOSTELLER_GIRLS'] },
            },
            select: {
                studentType: true,
                startTime: true,
            },
        }),
        getHostellerOutsideSnapshot(now),
    ]);

    const ruleMap = new Map(rules.map((rule) => [rule.studentType, rule.startTime]));

    for (const record of outsideStudents) {
        const student = record.student;
        if (!student?.id) continue;

        const startTime = ruleMap.get(student.studentType) || '21:00';
        const curfewStart = parseCurfewStartOnDate(now, startTime);
        const minutesToCurfew = Math.round((curfewStart.getTime() - now.getTime()) / (1000 * 60));

        let action = null;
        let title = null;
        let body = null;

        if (minutesToCurfew > 0 && minutesToCurfew <= 30) {
            action = 'CURFEW_REMINDER_30M';
            title = 'Curfew Alert';
            body = `Curfew Alert: You have ${minutesToCurfew} minutes to return to campus.`;
        } else if (minutesToCurfew <= 0) {
            action = 'CURFEW_CROSSED_WARNING';
            title = 'Curfew Crossed';
            body = 'Curfew time has crossed. Please contact warden and mark hostel entry immediately.';
        }

        if (!action) continue;

        const alreadySent = await prisma.studentAuthLog.findFirst({
            where: {
                studentId: student.id,
                action,
                createdAt: { gte: startOfDay },
            },
            select: { id: true },
        });

        if (alreadySent) continue;

        await sendPush({
            studentId: student.id,
            title,
            body,
            data: {
                type: 'CURFEW_ALERT',
                action,
                curfewStart: curfewStart.toISOString(),
                minutesToCurfew: String(minutesToCurfew),
            },
        });

        await prisma.studentAuthLog.create({
            data: {
                studentId: student.id,
                studentEmail: null,
                enrollmentNo: student.enrollmentNo || null,
                action,
                status: 'SUCCESS',
                reason: 'AUTO_CURFEW_NOTIFICATION',
                metadata: {
                    studentName: student.fullName,
                    source: record.source,
                    minutesToCurfew,
                    curfewStart: curfewStart.toISOString(),
                },
            },
        }).catch(() => { });
    }

    logger.info(`Curfew alerts processed for ${outsideStudents.length} outside hostellers`);
}

module.exports = { sendPush, scheduleOverdueReminders, scheduleAttendanceAlerts, scheduleHostellerCurfewAlerts };
