// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Attendance Service
// Session management, GPS validation, Haversine formula
// ═══════════════════════════════════════════════════════════════

const prisma = require('../config/database');
const { AppError } = require('../middleware/errorHandler');

const EARTH_RADIUS = 6371000; // metres

/**
 * Haversine formula — calculates distance between two GPS points.
 * @returns {number} distance in metres
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS * c;
}

/**
 * Start a new attendance session.
 */
async function startSession({ subjectId, facultyId }) {
    const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
    if (!subject) {
        throw new AppError('Subject not found', 404, 'NOT_FOUND');
    }
    if (subject.facultyId !== facultyId) {
        throw new AppError('You are not the faculty for this subject', 403, 'FORBIDDEN');
    }

    return prisma.attendanceSession.create({
        data: {
            subjectId,
            facultyId,
            status: 'OPEN',
        },
    });
}

/**
 * Mark attendance for a student in a session.
 */
async function markAttendance({ sessionId, studentId, gpsLat, gpsLng, overrideById, overrideReason }) {
    // Fetch session
    const session = await prisma.attendanceSession.findUnique({
        where: { id: sessionId },
        include: { subject: { include: { timetableSlots: true } } },
    });

    if (!session) {
        throw new AppError('Session not found', 404, 'NOT_FOUND');
    }
    if (session.status !== 'OPEN') {
        throw new AppError('Session is closed', 400, 'TIME_EXPIRED');
    }

    // If manual override, skip GPS and time checks
    const method = overrideById ? 'MANUAL_OVERRIDE' : 'SCAN';

    if (!overrideById) {
        // Check time window
        const now = new Date();
        const windowEnd = new Date(session.startedAt.getTime() + session.windowMinutes * 60 * 1000);
        if (now > windowEnd) {
            throw new AppError('Attendance window has expired', 400, 'TIME_EXPIRED');
        }

        // GPS check — find the timetable slot for this session
        if (gpsLat != null && gpsLng != null && session.subject.timetableSlots.length > 0) {
            const slot = session.subject.timetableSlots[0]; // Use first matching slot
            if (slot.gpsLat != null && slot.gpsLng != null) {
                const distance = haversineDistance(
                    parseFloat(gpsLat),
                    parseFloat(gpsLng),
                    parseFloat(slot.gpsLat),
                    parseFloat(slot.gpsLng)
                );
                if (distance > slot.gpsRadiusMetres) {
                    throw new AppError(
                        `GPS check failed: you are ${Math.round(distance)}m from the classroom (max ${slot.gpsRadiusMetres}m)`,
                        400,
                        'GPS_FAIL'
                    );
                }
            }
        }
    }

    // Check for duplicate
    const existing = await prisma.attendanceRecord.findUnique({
        where: { sessionId_studentId: { sessionId, studentId } },
    });
    if (existing) {
        throw new AppError('Student already marked in this session', 409, 'DUPLICATE');
    }

    // Create record
    return prisma.attendanceRecord.create({
        data: {
            sessionId,
            studentId,
            method,
            gpsLat: gpsLat != null ? parseFloat(gpsLat) : null,
            gpsLng: gpsLng != null ? parseFloat(gpsLng) : null,
            ...(overrideById && { overrideById, overrideReason }),
        },
        include: {
            student: { select: { id: true, fullName: true, enrollmentNo: true, photoUrl: true } },
        },
    });
}

/**
 * Close an attendance session.
 */
async function closeSession(sessionId, facultyId) {
    const session = await prisma.attendanceSession.findUnique({
        where: { id: sessionId },
    });
    if (!session) {
        throw new AppError('Session not found', 404, 'NOT_FOUND');
    }
    if (session.status === 'CLOSED') {
        throw new AppError('Session is already closed', 400, 'ALREADY_CLOSED');
    }

    return prisma.attendanceSession.update({
        where: { id: sessionId },
        data: { status: 'CLOSED', closedAt: new Date() },
    });
}

/**
 * Get attendance report for a subject over a date range.
 */
async function getAttendanceReport({ subjectId, startDate, endDate }) {
    const where = { subjectId };
    if (startDate || endDate) {
        where.startedAt = {};
        if (startDate) where.startedAt.gte = new Date(startDate);
        if (endDate) where.startedAt.lte = new Date(endDate);
    }

    const sessions = await prisma.attendanceSession.findMany({
        where,
        include: {
            records: {
                include: { student: { select: { id: true, fullName: true, enrollmentNo: true, department: true } } },
            },
        },
        orderBy: { startedAt: 'asc' },
    });

    // Build student-wise attendance grid
    const studentMap = {};
    for (const session of sessions) {
        for (const record of session.records) {
            const key = record.studentId;
            if (!studentMap[key]) {
                studentMap[key] = {
                    student: record.student,
                    sessions: {},
                    totalPresent: 0,
                };
            }
            studentMap[key].sessions[session.id.toString()] = true;
            studentMap[key].totalPresent++;
        }
    }

    const totalSessions = sessions.length;
    const students = Object.values(studentMap).map((s) => ({
        ...s,
        percentage: totalSessions > 0 ? Math.round((s.totalPresent / totalSessions) * 100) : 0,
    }));

    const defaulters = students.filter((s) => s.percentage < 75);

    return {
        totalSessions,
        sessions: sessions.map((s) => ({
            id: s.id.toString(),
            startedAt: s.startedAt,
            presentCount: s.records.length,
        })),
        students,
        defaulters,
    };
}

/**
 * Get defaulters below a given threshold.
 */
async function getDefaulters(threshold = 75) {
    // Get all subjects with sessions
    const subjects = await prisma.subject.findMany({
        include: {
            attendanceSessions: {
                include: {
                    records: { select: { studentId: true } },
                },
            },
        },
    });

    const defaulters = [];
    for (const subject of subjects) {
        const totalSessions = subject.attendanceSessions.length;
        if (totalSessions === 0) continue;

        const studentCounts = {};
        for (const session of subject.attendanceSessions) {
            for (const record of session.records) {
                studentCounts[record.studentId] = (studentCounts[record.studentId] || 0) + 1;
            }
        }

        // Get students enrolled or who have attended at least once
        for (const [studentId, count] of Object.entries(studentCounts)) {
            const percentage = Math.round((count / totalSessions) * 100);
            if (percentage < threshold) {
                defaulters.push({
                    studentId,
                    subjectCode: subject.code,
                    subjectName: subject.name,
                    present: count,
                    total: totalSessions,
                    percentage,
                });
            }
        }
    }

    // Fetch student details
    const studentIds = [...new Set(defaulters.map((d) => d.studentId))];
    const students = await prisma.student.findMany({
        where: { id: { in: studentIds } },
        select: { id: true, fullName: true, enrollmentNo: true, department: true, year: true },
    });
    const studentLookup = Object.fromEntries(students.map((s) => [s.id, s]));

    return defaulters.map((d) => ({
        ...d,
        student: studentLookup[d.studentId],
    }));
}

module.exports = {
    haversineDistance,
    startSession,
    markAttendance,
    closeSession,
    getAttendanceReport,
    getDefaulters,
};
