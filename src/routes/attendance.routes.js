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
    gpsLat: z.union([z.string(), z.number()]).optional(),
    gpsLng: z.union([z.string(), z.number()]).optional(),
});

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
router.get('/sessions', authenticate, requireRole('FACULTY', 'SECURITY_GUARD', 'HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const prisma = require('../config/database');
        const where = {};
        if (req.query.status) {
            where.status = req.query.status;
        }
        if (req.query.facultyId) {
            where.facultyId = req.query.facultyId;
        }
        const sessions = await prisma.attendanceSession.findMany({
            where,
            include: {
                subject: { select: { id: true, code: true, name: true, department: true } },
                _count: { select: { records: true } },
            },
            orderBy: { startedAt: 'desc' },
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

module.exports = router;
