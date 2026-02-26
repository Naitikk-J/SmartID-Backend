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

module.exports = { sendPush, scheduleOverdueReminders, scheduleAttendanceAlerts };
