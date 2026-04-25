// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Attendance Service
// Session management, GPS validation, Haversine formula, QR modes
// ═══════════════════════════════════════════════════════════════

const prisma = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const crypto = require('crypto');
const { getGeofencingSettings } = require('./geofencing-settings.service');

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
 * Generate QR token for session.
 */
function generateSessionQrToken(sessionId, mode, validitySeconds) {
    const timestamp = Date.now();
    const random = crypto.randomBytes(16).toString('hex');
    const expiresAt = mode === 'DYNAMIC' ? new Date(timestamp + validitySeconds * 1000) : null;
    const tokenData = { sessionId, timestamp, random, mode, expiresAt };
    return {
        token: Buffer.from(JSON.stringify(tokenData)).toString('base64url'),
        expiresAt,
    };
}

/**
 * Start a new attendance session with QR configuration.
 */
async function startSession({ subjectId, facultyId, role = 'FACULTY', className, classListId, qrMode = 'STATIC', qrValiditySeconds = 60, windowMinutes = 15 }) {
    const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
    if (!subject) {
        throw new AppError('Subject not found', 404, 'NOT_FOUND');
    }
    if (role !== 'SUPER_ADMIN' && subject.facultyId !== facultyId) {
        throw new AppError('You are not the faculty for this subject', 403, 'FORBIDDEN');
    }

    // Create session first to get ID
    const session = await prisma.attendanceSession.create({
        data: {
            subjectId,
            facultyId,
            status: 'OPEN',
            windowMinutes,
            qrMode,
            qrValiditySeconds,
            className,
            classListId,
        },
    });

    // Generate QR token
    const { token, expiresAt } = generateSessionQrToken(session.id, qrMode, qrValiditySeconds);

    // Update session with QR token
    return prisma.attendanceSession.update({
        where: { id: session.id },
        data: { qrToken: token, qrExpiresAt: expiresAt },
        include: {
            subject: true,
            classList: { include: { faculty: { select: { id: true, name: true } } } },
        },
    });
}

/**
 * Refresh QR token for dynamic mode.
 */
async function refreshSessionQr(sessionId, facultyId) {
    const session = await prisma.attendanceSession.findUnique({ where: { id: sessionId } });
    if (!session) {
        throw new AppError('Session not found', 404, 'NOT_FOUND');
    }
    if (session.facultyId !== facultyId) {
        throw new AppError('Not authorized', 403, 'FORBIDDEN');
    }
    if (session.qrMode !== 'DYNAMIC') {
        throw new AppError('QR refresh only available for dynamic mode', 400, 'INVALID_MODE');
    }
    if (session.status !== 'OPEN') {
        throw new AppError('Session is closed', 400, 'SESSION_CLOSED');
    }

    const { token, expiresAt } = generateSessionQrToken(session.id, 'DYNAMIC', session.qrValiditySeconds);

    return prisma.attendanceSession.update({
        where: { id: sessionId },
        data: { qrToken: token, qrExpiresAt: expiresAt },
        include: { subject: true },
    });
}

/**
 * Get session with marked/unmarked student lists.
 */
async function getSessionWithAttendance(sessionId) {
    const session = await prisma.attendanceSession.findUnique({
        where: { id: sessionId },
        include: {
            subject: true,
            classList: true,
            records: {
                include: {
                    student: { select: { id: true, fullName: true, enrollmentNo: true, photoUrl: true, email: true, department: true, year: true } },
                },
                orderBy: { markedAt: 'desc' },
            },
        },
    });

    if (!session) {
        throw new AppError('Session not found', 404, 'NOT_FOUND');
    }

    // Get all students in class list if available
    let allStudents = [];
    if (session.classList && session.classList.studentIds.length > 0) {
        allStudents = await prisma.student.findMany({
            where: { id: { in: session.classList.studentIds } },
            select: { id: true, fullName: true, enrollmentNo: true, photoUrl: true, email: true, department: true, year: true },
        });
    }

    const markedStudentIds = new Set(session.records.map((r) => r.studentId));
    const marked = session.records.map((r) => ({
        ...r.student,
        markedAt: r.markedAt,
        method: r.method,
    }));
    const unmarked = allStudents.filter((s) => !markedStudentIds.has(s.id));

    return {
        ...session,
        id: session.id.toString(),
        marked,
        unmarked,
        totalStudents: allStudents.length,
        presentCount: marked.length,
        absentCount: unmarked.length,
    };
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

        // GPS check — use global attendance geofencing settings
        if (gpsLat != null && gpsLng != null) {
            const geofencingSettings = getGeofencingSettings();
            const effectiveAttendanceRadius = Math.max(
                geofencingSettings.campusRadiusMetres,
                geofencingSettings.attendanceRadiusMetres,
            ) + 50;
            const distance = haversineDistance(
                parseFloat(gpsLat),
                parseFloat(gpsLng),
                geofencingSettings.campusCenterLat,
                geofencingSettings.campusCenterLng,
            );

            if (distance > effectiveAttendanceRadius) {
                throw new AppError(
                    `GPS check failed: you are ${Math.round(distance)}m from campus center (max ${effectiveAttendanceRadius}m)`,
                    400,
                    'GPS_FAIL'
                );
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
 * Auto-expire any OPEN sessions whose window has elapsed.
 * Called lazily before GET /sessions so there's no cron dependency.
 */
async function autoExpireStaleSessions() {
    try {
        const openSessions = await prisma.attendanceSession.findMany({
            where: { status: 'OPEN' },
            select: { id: true, startedAt: true, windowMinutes: true },
        });

        const now = Date.now();
        const staleIds = openSessions
            .filter(s => {
                const windowEnd = new Date(s.startedAt).getTime() + s.windowMinutes * 60 * 1000;
                return now > windowEnd;
            })
            .map(s => s.id);

        if (staleIds.length > 0) {
            await prisma.attendanceSession.updateMany({
                where: { id: { in: staleIds } },
                data: { status: 'CLOSED', closedAt: new Date() },
            });
        }

        return staleIds.length;
    } catch (err) {
        // Non-critical — log but don't throw
        console.error('[autoExpire] Failed to auto-expire sessions:', err.message);
        return 0;
    }
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

/**
 * Unmark attendance for a student in a session.
 */
async function unmarkAttendance({ sessionId, studentId, overrideById, overrideReason }) {
    const session = await prisma.attendanceSession.findUnique({
        where: { id: sessionId },
    });

    if (!session) {
        throw new AppError('Session not found', 404, 'NOT_FOUND');
    }
    if (session.status !== 'OPEN') {
        throw new AppError('Session is closed', 400, 'SESSION_CLOSED');
    }

    const record = await prisma.attendanceRecord.findUnique({
        where: { sessionId_studentId: { sessionId, studentId } },
    });

    if (!record) {
        throw new AppError('Attendance record not found', 404, 'NOT_FOUND');
    }

    // Delete the record
    await prisma.attendanceRecord.delete({
        where: { id: record.id },
    });

    return { success: true, message: 'Attendance unmarked' };
}

// ═══════════════════════════════════════════════════════════════
// Class List Management
// ═══════════════════════════════════════════════════════════════

/**
 * Create a new class list for a faculty.
 */
async function createClassList({ name, department, year, section, facultyId, studentIds }) {
    // Verify all students exist and belong to the specified department/year
    const students = await prisma.student.findMany({
        where: {
            id: { in: studentIds },
            department,
            year,
        },
        select: { id: true },
    });

    const foundIds = students.map((s) => s.id);
    const notFound = studentIds.filter((id) => !foundIds.includes(id));

    if (notFound.length > 0) {
        throw new AppError(
            `Some students not found or don't match department/year: ${notFound.length} students`,
            400,
            'INVALID_STUDENTS'
        );
    }

    return prisma.sessionClassList.create({
        data: {
            name,
            department,
            year,
            section,
            facultyId,
            studentIds: foundIds,
        },
    });
}

/**
 * Get all class lists for a faculty.
 */
async function getClassLists(userId, { department, year } = {}, role = 'FACULTY') {
    const where = { isActive: true };
    if (role === 'FACULTY') {
        where.facultyId = userId;
    }
    if (department) where.department = department;
    if (year) where.year = parseInt(year);

    const classLists = await prisma.sessionClassList.findMany({
        where,
        orderBy: { createdAt: 'desc' },
    });

    // Add studentCount to each class list
    return classLists.map(list => ({
        ...list,
        studentCount: list.studentIds?.length || 0,
    }));
}

/**
 * Get a single class list with student details.
 */
async function getClassListWithStudents(classListId, facultyId) {
    const classList = await prisma.sessionClassList.findFirst({
        where: { id: classListId, facultyId },
    });

    if (!classList) {
        throw new AppError('Class list not found', 404, 'NOT_FOUND');
    }

    const students = await prisma.student.findMany({
        where: { id: { in: classList.studentIds } },
        select: {
            id: true,
            fullName: true,
            enrollmentNo: true,
            email: true,
            photoUrl: true,
            department: true,
            year: true,
            section: true,
        },
        orderBy: { fullName: 'asc' },
    });

    return {
        ...classList,
        students,
        studentCount: students.length,
    };
}

/**
 * Update a class list.
 */
async function updateClassList(classListId, facultyId, { name, studentIds, isActive }) {
    const classList = await prisma.sessionClassList.findFirst({
        where: { id: classListId, facultyId },
    });

    if (!classList) {
        throw new AppError('Class list not found', 404, 'NOT_FOUND');
    }

    const data = {};
    if (name !== undefined) data.name = name;
    if (isActive !== undefined) data.isActive = isActive;

    if (studentIds !== undefined) {
        // Verify all students exist
        const students = await prisma.student.findMany({
            where: { id: { in: studentIds } },
            select: { id: true },
        });
        data.studentIds = students.map((s) => s.id);
    }

    return prisma.sessionClassList.update({
        where: { id: classListId },
        data,
    });
}

/**
 * Delete a class list.
 */
async function deleteClassList(classListId, facultyId) {
    const classList = await prisma.sessionClassList.findFirst({
        where: { id: classListId, facultyId },
    });

    if (!classList) {
        throw new AppError('Class list not found', 404, 'NOT_FOUND');
    }

    // Check if class list is used in any sessions
    const sessionsUsing = await prisma.attendanceSession.count({
        where: { classListId },
    });

    if (sessionsUsing > 0) {
        // Soft delete - mark as inactive
        return prisma.sessionClassList.update({
            where: { id: classListId },
            data: { isActive: false },
        });
    }

    return prisma.sessionClassList.delete({
        where: { id: classListId },
    });
}

module.exports = {
    haversineDistance,
    generateSessionQrToken,
    startSession,
    refreshSessionQr,
    getSessionWithAttendance,
    markAttendance,
    unmarkAttendance,
    autoExpireStaleSessions,
    closeSession,
    getAttendanceReport,
    getDefaulters,
    createClassList,
    getClassLists,
    getClassListWithStudents,
    updateClassList,
    deleteClassList,
};
