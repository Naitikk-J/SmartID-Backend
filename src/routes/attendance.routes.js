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

const router = express.Router();

const startSessionSchema = z.object({
    subjectId: z.string().min(1),
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

// ── POST /sessions/start ────────────────────────────────────
router.post('/sessions/start', authenticate, requireRole('FACULTY', 'SECURITY_GUARD', 'HOD', 'SUPER_ADMIN'), validate(startSessionSchema), async (req, res, next) => {
    try {
        const session = await attendanceService.startSession({
            subjectId: req.body.subjectId,
            facultyId: req.user.id,
        });
        res.status(201).json({
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

module.exports = router;
