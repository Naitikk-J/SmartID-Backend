// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Attendance Routes
// Sessions, marking, override, reports, defaulters
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { z } = require('zod');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const attendanceService = require('../services/attendance.service');
const scanService = require('../services/scan.service');
const { logAction } = require('../services/audit.service');

const router = express.Router();

const startSessionSchema = z.object({
    subjectId: z.string().min(1),
    className: z.string().optional(),
    classListId: z.string().optional(),
    qrMode: z.enum(['STATIC', 'DYNAMIC']).optional(),
    qrValiditySeconds: z.coerce.number().int().min(10).max(600).optional(),
    windowMinutes: z.coerce.number().int().min(5).max(120).optional(),
});

const manualMarkSchema = z.object({
    studentId: z.string().min(1),
    action: z.enum(['mark', 'unmark']).default('mark'),
    reason: z.string().optional(),
});

const markSchema = z.object({
    rawToken: z.string().min(1),
    gpsLat: z.union([z.string(), z.number()]).nullish(),
    gpsLng: z.union([z.string(), z.number()]).nullish(),
});

const studentSessionScanSchema = z.object({
    rawToken: z.string().min(1),
    gpsLat: z.union([z.string(), z.number()]).nullish(),
    gpsLng: z.union([z.string(), z.number()]).nullish(),
});

function parseSessionQrToken(rawToken) {
    try {
        const decoded = Buffer.from(String(rawToken), 'base64url').toString('utf8');
        const payload = JSON.parse(decoded);
        if (!payload || typeof payload !== 'object') return null;
        if (!payload.sessionId) return null;
        return payload;
    } catch (_) {
        return null;
    }
}

const overrideSchema = z.object({
    studentId: z.string().min(1),
    reason: z.string().min(1, 'Override reason required'),
    action: z.enum(['mark', 'unmark']).default('mark'),
});

// ── GET /subjects ───────────────────────────────────────────
router.get('/subjects', authenticate, requireRole('FACULTY', 'HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const prisma = require('../config/database');
        const where = {};
        if (req.user.role === 'FACULTY') {
            where.facultyId = req.user.id;
        }
        const subjects = await prisma.subject.findMany({
            where,
            orderBy: { code: 'asc' },
        });
        res.json({ success: true, data: { subjects } });
    } catch (err) {
        next(err);
    }
});

// ── GET /sessions ───────────────────────────────────────────
// FACULTY only sees their own sessions; HOD/SUPER_ADMIN see all
router.get('/sessions', authenticate, requireRole('FACULTY', 'SECURITY_GUARD', 'HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const prisma = require('../config/database');
        const where = {};
        if (req.query.status) {
            where.status = req.query.status;
        }
        // Faculty can only see their own sessions
        if (req.user.role === 'FACULTY') {
            where.facultyId = req.user.id;
        } else if (req.query.facultyId) {
            where.facultyId = req.query.facultyId;
        }

        // Auto-expire stale open sessions before returning results
        await attendanceService.autoExpireStaleSessions();

        const sessions = await prisma.attendanceSession.findMany({
            where,
            include: {
                subject: { select: { id: true, code: true, name: true, department: true } },
                faculty: { select: { id: true, name: true, email: true } },
                _count: { select: { records: true } },
            },
            orderBy: { startedAt: 'desc' },
            take: req.query.limit ? parseInt(req.query.limit) : 50,
        });

        // Fetch class lists separately if needed
        const classListIds = sessions.filter(s => s.classListId).map(s => s.classListId);
        let classListsMap = {};
        if (classListIds.length > 0) {
            const classLists = await prisma.sessionClassList.findMany({
                where: { id: { in: classListIds } },
                select: { id: true, name: true, department: true, year: true, section: true }
            });
            classListsMap = Object.fromEntries(classLists.map(cl => [cl.id, cl]));
        }

        // Attach classList data to sessions
        const sessionsWithClassList = sessions.map(s => ({
            ...s,
            classList: s.classListId ? classListsMap[s.classListId] || null : null
        }));
        res.json({ success: true, data: { sessions: sessionsWithClassList } });
    } catch (err) {
        next(err);
    }
});

// ── POST /sessions/start ────────────────────────────────────
router.post('/sessions/start', authenticate, requireRole('FACULTY', 'SECURITY_GUARD', 'HOD', 'SUPER_ADMIN'), validate(startSessionSchema), async (req, res, next) => {
    try {
        const session = await attendanceService.startSession({
            subjectId: req.body.subjectId,
            facultyId: req.user.id,
            role: req.user.role,
            className: req.body.className,
            classListId: req.body.classListId,
            qrMode: req.body.qrMode,
            qrValiditySeconds: req.body.qrValiditySeconds,
            windowMinutes: req.body.windowMinutes,
        });
        res.status(201).json({
            success: true,
            data: { session },
        });

        await logAction(req, {
            action: 'START_ATTENDANCE_SESSION',
            entity: 'AttendanceSession',
            entityId: session.id.toString(),
            newValue: { subjectId: req.body.subjectId, qrMode: req.body.qrMode }
        }).catch(() => { });
    } catch (err) {
        next(err);
    }
});

// ── POST /sessions/:id/refresh-qr ─────────────────────────────
router.post('/sessions/:id/refresh-qr', authenticate, requireRole('FACULTY', 'HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const session = await attendanceService.refreshSessionQr(req.params.id, req.user.id);
        res.json({
            success: true,
            data: { session },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /sessions/:id/live ────────────────────────────────────
router.get('/sessions/:id/live', authenticate, requireRole('FACULTY', 'SECURITY_GUARD', 'HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const session = await attendanceService.getSessionWithAttendance(req.params.id);
        res.json({
            success: true,
            data: { session },
        });
    } catch (err) {
        next(err);
    }
});

// ── POST /sessions/:id/close ────────────────────────────────
router.post('/sessions/:id/close', authenticate, requireRole('FACULTY', 'SECURITY_GUARD', 'HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const session = await attendanceService.closeSession(req.params.id, req.user.id);
        res.json({
            success: true,
            data: { session },
        });

        await logAction(req, {
            action: 'CLOSE_ATTENDANCE_SESSION',
            entity: 'AttendanceSession',
            entityId: req.params.id
        }).catch(() => { });
    } catch (err) {
        next(err);
    }
});

// ── GET /sessions/:id/export ─── CSV/Excel attendance report ─
router.get('/sessions/:id/export', authenticate, requireRole('FACULTY', 'HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const prisma = require('../config/database');
        const session = await prisma.attendanceSession.findUnique({
            where: { id: req.params.id },
            include: {
                subject: true,
                faculty: { select: { name: true, email: true } },
                classList: true,
                records: {
                    include: {
                        student: {
                            select: {
                                id: true, fullName: true, enrollmentNo: true,
                                email: true, department: true, year: true, section: true,
                            },
                        },
                    },
                    orderBy: { markedAt: 'asc' },
                },
            },
        });

        if (!session) {
            const { AppError } = require('../middleware/errorHandler');
            throw new AppError('Session not found', 404);
        }

        // Faculty can only export their own sessions
        if (req.user.role === 'FACULTY' && session.facultyId !== req.user.id) {
            const { AppError } = require('../middleware/errorHandler');
            throw new AppError('You can only export your own sessions', 403);
        }

        // Build complete student list (from class list if available)
        let allStudents = [];
        if (session.classList && session.classList.studentIds.length > 0) {
            allStudents = await prisma.student.findMany({
                where: { id: { in: session.classList.studentIds } },
                select: {
                    id: true, fullName: true, enrollmentNo: true,
                    email: true, department: true, year: true, section: true,
                },
                orderBy: { enrollmentNo: 'asc' },
            });
        }

        const markedSet = new Map(session.records.map(r => [r.studentId, r]));

        // Build CSV rows
        const csvHeader = 'S.No,Enrollment No,Student Name,Department,Year,Section,Status,Marked At,Method';
        const rows = [];
        let sno = 1;

        if (allStudents.length > 0) {
            // Full class list with present/absent
            const processedIds = new Set();
            for (const student of allStudents) {
                processedIds.add(student.id);
                const record = markedSet.get(student.id);
                rows.push([
                    sno++,
                    student.enrollmentNo,
                    `"${student.fullName}"`,
                    student.department || '',
                    student.year || '',
                    student.section || '',
                    record ? 'PRESENT' : 'ABSENT',
                    record ? new Date(record.markedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '',
                    record ? record.method : '',
                ].join(','));
            }

            // Also add students who marked attendance but were not in the class list
            for (const record of session.records) {
                if (!processedIds.has(record.studentId)) {
                    rows.push([
                        sno++,
                        record.student.enrollmentNo,
                        `"${record.student.fullName}"`,
                        record.student.department || '',
                        record.student.year || '',
                        record.student.section || '',
                        'PRESENT',
                        new Date(record.markedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                        record.method,
                    ].join(','));
                }
            }
        } else {
            // Only marked students (no class list)
            for (const record of session.records) {
                rows.push([
                    sno++,
                    record.student.enrollmentNo,
                    `"${record.student.fullName}"`,
                    record.student.department || '',
                    record.student.year || '',
                    record.student.section || '',
                    'PRESENT',
                    new Date(record.markedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                    record.method,
                ].join(','));
            }
        }

        // Metadata header lines
        const meta = [
            `# Attendance Report`,
            `# Subject: ${session.subject?.code || ''} - ${session.subject?.name || ''}`,
            `# Class: ${session.className || 'N/A'}`,
            `# Faculty: ${session.faculty?.name || 'N/A'}`,
            `# Date: ${new Date(session.startedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
            `# Status: ${session.status}`,
            `# Total Present: ${session.records.length}${allStudents.length > 0 ? ' / ' + allStudents.length : ''}`,
            '',
        ];

        const csvContent = [...meta, csvHeader, ...rows].join('\n');
        const filename = `attendance_${session.subject?.code || 'session'}_${new Date(session.startedAt).toISOString().slice(0, 10)}.csv`;

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csvContent);
    } catch (err) {
        next(err);
    }
});

// ── GET /sessions/:id ──────────────────────────────────────
router.get('/sessions/:id', authenticate, requireRole('FACULTY', 'SECURITY_GUARD', 'HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const prisma = require('../config/database');
        const session = await prisma.attendanceSession.findUnique({
            where: { id: req.params.id },
            include: {
                subject: true,
                records: {
                    include: {
                        student: { select: { id: true, fullName: true, enrollmentNo: true, photoUrl: true } },
                    },
                },
            },
        });
        if (!session) {
            const { AppError } = require('../middleware/errorHandler');
            throw new AppError('Session not found', 404);
        }
        res.json({
            success: true,
            data: {
                session: {
                    ...session,
                    id: session.id.toString(),
                    records: session.records.map((r) => ({ ...r, id: r.id.toString(), sessionId: r.sessionId.toString() })),
                },
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── POST /sessions/:id/mark — scan for attendance ──────────
router.post('/sessions/:id/mark', authenticate, requireRole('FACULTY', 'SECURITY_GUARD', 'HOD', 'SUPER_ADMIN'), validate(markSchema), async (req, res, next) => {
    try {
        const result = await scanService.verifyScan({
            rawToken: req.body.rawToken,
            gpsLat: req.body.gpsLat,
            gpsLng: req.body.gpsLng,
            scanType: 'ATTENDANCE',
            operatorId: req.user.id,
            metadata: { sessionId: req.params.id },
        });
        res.json({ success: true, data: result });
    } catch (err) {
        next(err);
    }
});

// ── POST /sessions/scan — student scans session QR ──────────
router.post('/sessions/scan', authenticate, requireRole('STUDENT'), validate(studentSessionScanSchema), async (req, res, next) => {
    try {
        const rawToken = String(req.body.rawToken || '').trim();
        const tokenPayload = parseSessionQrToken(rawToken);
        if (!tokenPayload?.sessionId) {
            return res.status(400).json({
                success: false,
                error: 'Invalid attendance session QR',
                code: 'INVALID_SESSION_QR',
            });
        }

        const prisma = require('../config/database');
        const session = await prisma.attendanceSession.findUnique({
            where: { id: tokenPayload.sessionId },
            select: {
                id: true,
                status: true,
                qrToken: true,
                qrMode: true,
                qrExpiresAt: true,
            },
        });

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'Attendance session not found',
                code: 'SESSION_NOT_FOUND',
            });
        }

        if (session.status !== 'OPEN') {
            return res.status(400).json({
                success: false,
                error: 'Attendance session is closed',
                code: 'SESSION_CLOSED',
            });
        }

        if (session.qrToken !== rawToken) {
            return res.status(400).json({
                success: false,
                error: 'This QR is expired. Please scan the latest session QR.',
                code: 'SESSION_QR_EXPIRED',
            });
        }

        if (session.qrMode === 'DYNAMIC' && session.qrExpiresAt && new Date() > session.qrExpiresAt) {
            return res.status(400).json({
                success: false,
                error: 'This dynamic session QR has expired. Ask faculty to refresh QR.',
                code: 'SESSION_QR_EXPIRED',
            });
        }

        const record = await attendanceService.markAttendance({
            sessionId: session.id,
            studentId: req.user.id,
            gpsLat: req.body.gpsLat,
            gpsLng: req.body.gpsLng,
        });

        return res.json({
            success: true,
            data: {
                result: 'VERIFIED',
                badge: 'GREEN',
                message: `Attendance marked: ${record.student.fullName}`,
                sessionId: session.id,
                student: {
                    id: record.student.id,
                    fullName: record.student.fullName,
                    enrollmentNo: record.student.enrollmentNo,
                    photoUrl: record.student.photoUrl,
                },
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── POST /sessions/:id/manual-mark ──────────────────────────
router.post('/sessions/:id/manual-mark', authenticate, requireRole('FACULTY', 'HOD', 'SUPER_ADMIN'), validate(manualMarkSchema), async (req, res, next) => {
    try {
        const { studentId, action, reason } = req.body;
        let result;

        if (action === 'unmark') {
            result = await attendanceService.unmarkAttendance({
                sessionId: req.params.id,
                studentId,
                overrideById: req.user.id,
                overrideReason: reason,
            });
        } else {
            result = await attendanceService.markAttendance({
                sessionId: req.params.id,
                studentId,
                overrideById: req.user.id,
                overrideReason: reason,
            });
        }

        res.json({
            success: true,
            data: { result: { ...result, id: result.id?.toString(), sessionId: result.sessionId?.toString() } },
        });

        await logAction(req, {
            action: action === 'unmark' ? 'UNMARK_ATTENDANCE' : 'MARK_ATTENDANCE_MANUAL',
            entity: 'AttendanceRecord',
            entityId: result.id?.toString() || req.params.id,
            newValue: { studentId, action, reason }
        }).catch(() => { });
    } catch (err) {
        next(err);
    }
});

// ── POST /sessions/:id/override ─────────────────────────────
router.post('/sessions/:id/override', authenticate, requireRole('HOD', 'SUPER_ADMIN'), validate(overrideSchema), async (req, res, next) => {
    try {
        const record = await attendanceService.markAttendance({
            sessionId: req.params.id,
            studentId: req.body.studentId,
            overrideById: req.user.id,
            overrideReason: req.body.reason,
        });
        res.json({
            success: true,
            data: { record: { ...record, id: record.id.toString(), sessionId: record.sessionId.toString() } },
        });

        await logAction(req, {
            action: 'MARK_ATTENDANCE_OVERRIDE',
            entity: 'AttendanceRecord',
            entityId: record.id.toString(),
            newValue: { studentId: req.body.studentId, reason: req.body.reason }
        }).catch(() => { });
    } catch (err) {
        next(err);
    }
});

// ── GET /report ─────────────────────────────────────────────
router.get('/report', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'FACULTY'), async (req, res, next) => {
    try {
        const { subjectId, startDate, endDate } = req.query;
        if (!subjectId) {
            const { AppError } = require('../middleware/errorHandler');
            throw new AppError('subjectId is required', 400);
        }
        const report = await attendanceService.getAttendanceReport({ subjectId, startDate, endDate });
        res.json({ success: true, data: report });
    } catch (err) {
        next(err);
    }
});

// ── GET /defaulters ─────────────────────────────────────────
router.get('/defaulters', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'FACULTY'), async (req, res, next) => {
    try {
        const threshold = parseInt(req.query.threshold) || 75;
        const defaulters = await attendanceService.getDefaulters(threshold);
        res.json({ success: true, data: { defaulters } });
    } catch (err) {
        next(err);
    }
});

// ═══════════════════════════════════════════════════════════════
// Class List Routes
// ═══════════════════════════════════════════════════════════════

const classListSchema = z.object({
    name: z.string().min(1),
    department: z.string().min(1),
    year: z.coerce.number().int().min(1).max(4),
    section: z.string().optional(),
    studentIds: z.array(z.string()).min(1),
});

// ── GET /class-lists ─────────────────────────────────────────
router.get('/class-lists', authenticate, requireRole('FACULTY', 'HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const classLists = await attendanceService.getClassLists(req.user.id, {
            department: req.query.department,
            year: req.query.year,
        }, req.user.role);
        res.json({ success: true, data: { classLists } });
    } catch (err) {
        next(err);
    }
});

// ── POST /class-lists ─────────────────────────────────────────
router.post('/class-lists', authenticate, requireRole('FACULTY', 'HOD', 'SUPER_ADMIN'), validate(classListSchema), async (req, res, next) => {
    try {
        const classList = await attendanceService.createClassList({
            ...req.body,
            facultyId: req.user.id,
        });
        res.status(201).json({ success: true, data: { classList } });

        await logAction(req, {
            action: 'CREATE_CLASS_LIST',
            entity: 'SessionClassList',
            entityId: classList.id.toString(),
            newValue: { name: req.body.name, studentCount: req.body.studentIds.length }
        }).catch(() => { });
    } catch (err) {
        next(err);
    }
});

// ── GET /class-lists/:id ────────────────────────────────────
router.get('/class-lists/:id', authenticate, requireRole('FACULTY', 'HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const classList = await attendanceService.getClassListWithStudents(req.params.id, req.user.id);
        res.json({ success: true, data: { classList } });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /class-lists/:id ───────────────────────────────────
router.patch('/class-lists/:id', authenticate, requireRole('FACULTY', 'HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const classList = await attendanceService.updateClassList(req.params.id, req.user.id, req.body);
        res.json({ success: true, data: { classList } });

        await logAction(req, {
            action: 'UPDATE_CLASS_LIST',
            entity: 'SessionClassList',
            entityId: classList.id.toString(),
        }).catch(() => { });
    } catch (err) {
        next(err);
    }
});

// ── DELETE /class-lists/:id ──────────────────────────────────
router.delete('/class-lists/:id', authenticate, requireRole('FACULTY', 'HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        await attendanceService.deleteClassList(req.params.id, req.user.id);
        res.json({ success: true, data: { message: 'Class list deleted' } });

        await logAction(req, {
            action: 'DELETE_CLASS_LIST',
            entity: 'SessionClassList',
            entityId: req.params.id,
        }).catch(() => { });
    } catch (err) {
        next(err);
    }
});

// ── GET /my-attendance ──────────────────────────────────────
// Student-facing: returns attendance summary per subject
router.get('/my-attendance', authenticate, requireRole('STUDENT'), async (req, res, next) => {
    try {
        const prisma = require('../config/database');
        const studentId = req.user.id;

        // Get all attendance records for this student
        const records = await prisma.attendanceRecord.findMany({
            where: { studentId },
            select: {
                sessionId: true,
                markedAt: true,
                method: true,
                session: {
                    select: {
                        id: true,
                        status: true,
                        startedAt: true,
                        className: true,
                        subject: {
                            select: {
                                id: true,
                                code: true,
                                name: true,
                                department: true,
                            },
                        },
                    },
                },
            },
            orderBy: { markedAt: 'desc' },
        });

        // Get all closed sessions to compute totals per subject
        const subjectIds = [...new Set(records.map((r) => r.session?.subject?.id).filter(Boolean))];
        const allSessions = subjectIds.length > 0
            ? await prisma.attendanceSession.findMany({
                where: {
                    subjectId: { in: subjectIds },
                    status: 'CLOSED',
                },
                select: {
                    id: true,
                    subjectId: true,
                },
            })
            : [];

        // Build per-subject summary
        const subjectMap = {};
        for (const record of records) {
            const subject = record.session?.subject;
            if (!subject) continue;
            if (!subjectMap[subject.id]) {
                subjectMap[subject.id] = {
                    subjectId: subject.id,
                    subjectCode: subject.code,
                    subjectName: subject.name,
                    department: subject.department,
                    present: 0,
                    total: 0,
                    percentage: 0,
                    recentSessions: [],
                };
            }
            subjectMap[subject.id].present++;
            subjectMap[subject.id].recentSessions.push({
                sessionId: record.sessionId,
                date: record.session.startedAt,
                className: record.session.className,
                status: 'PRESENT',
            });
        }

        // Fill total from all closed sessions
        for (const session of allSessions) {
            if (subjectMap[session.subjectId]) {
                subjectMap[session.subjectId].total++;
            }
        }

        // Calculate percentages
        const subjects = Object.values(subjectMap).map((s) => ({
            ...s,
            percentage: s.total > 0 ? Math.round((s.present / s.total) * 100) : 100,
            recentSessions: s.recentSessions.slice(0, 10),
        }));

        res.json({
            success: true,
            data: {
                subjects,
                totalPresent: records.length,
                totalSessions: allSessions.length,
                overallPercentage: allSessions.length > 0
                    ? Math.round((records.length / allSessions.length) * 100)
                    : 100,
            },
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
