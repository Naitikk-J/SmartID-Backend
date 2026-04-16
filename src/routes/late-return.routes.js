const express = require('express');
const { z } = require('zod');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const prisma = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { sendPush } = require('../services/notification.service');

const router = express.Router();

const createLateReturnSchema = z.object({
    eta: z.string().transform((value) => new Date(value)),
    reason: z.string().trim().min(5).max(240),
    latitude: z.coerce.number().min(-90).max(90),
    longitude: z.coerce.number().min(-180).max(180),
});

const resolveLateReturnSchema = z.object({
    status: z.enum(['ACKNOWLEDGED', 'RESOLVED', 'REJECTED']),
    adminNote: z.string().trim().max(240).optional(),
});

router.post('/request', authenticate, requireRole('STUDENT'), validate(createLateReturnSchema), async (req, res, next) => {
    try {
        const payload = req.body;
        const eta = payload.eta instanceof Date ? payload.eta : new Date(payload.eta);

        if (Number.isNaN(eta.getTime())) {
            throw new AppError('Invalid ETA', 400, 'INVALID_ETA');
        }

        if (!Number.isFinite(payload.latitude) || !Number.isFinite(payload.longitude)) {
            throw new AppError('Location is required', 400, 'LOCATION_REQUIRED');
        }

        const request = await prisma.lateReturnRequest.create({
            data: {
                studentId: req.user.id,
                eta,
                reason: payload.reason,
                latitude: payload.latitude ?? null,
                longitude: payload.longitude ?? null,
                status: 'PENDING',
            },
        });

        await prisma.studentAuthLog.create({
            data: {
                studentId: req.user.id,
                action: 'LATE_RETURN_REQUESTED',
                status: 'PENDING',
                reason: payload.reason,
                metadata: {
                    lateReturnRequestId: request.id,
                    eta: eta.toISOString(),
                    latitude: payload.latitude ?? null,
                    longitude: payload.longitude ?? null,
                },
            },
        }).catch(() => { });

        await sendPush({
            studentId: req.user.id,
            title: 'Late return request submitted',
            body: 'Your request has been sent to warden panel for review.',
            data: {
                type: 'LATE_RETURN',
                status: 'PENDING',
                lateReturnRequestId: String(request.id),
            },
        });

        res.status(201).json({
            success: true,
            data: request,
        });
    } catch (err) {
        next(err);
    }
});

router.get('/me', authenticate, requireRole('STUDENT'), async (req, res, next) => {
    try {
        const requests = await prisma.lateReturnRequest.findMany({
            where: { studentId: req.user.id },
            orderBy: { requestedAt: 'desc' },
            take: 20,
        });

        res.json({ success: true, data: requests });
    } catch (err) {
        next(err);
    }
});

router.get('/pending', authenticate, requireRole('SUPER_ADMIN', 'HOD', 'WARDEN', 'FACULTY', 'SECURITY_GUARD'), async (req, res, next) => {
    try {
        const requests = await prisma.lateReturnRequest.findMany({
            where: { status: 'PENDING' },
            include: {
                student: {
                    select: {
                        id: true,
                        fullName: true,
                        enrollmentNo: true,
                        department: true,
                        studentType: true,
                        roomNo: true,
                        phone: true,
                    },
                },
            },
            orderBy: { requestedAt: 'desc' },
            take: 200,
        });

        res.json({ success: true, data: requests });
    } catch (err) {
        next(err);
    }
});

router.patch('/:id/status', authenticate, requireRole('SUPER_ADMIN', 'HOD', 'WARDEN', 'FACULTY'), validate(resolveLateReturnSchema), async (req, res, next) => {
    try {
        const existing = await prisma.lateReturnRequest.findUnique({
            where: { id: req.params.id },
            include: {
                student: {
                    select: {
                        id: true,
                    },
                },
            },
        });

        if (!existing) {
            throw new AppError('Late return request not found', 404, 'LATE_RETURN_NOT_FOUND');
        }

        const resolved = await prisma.lateReturnRequest.update({
            where: { id: req.params.id },
            data: {
                status: req.body.status,
                adminNote: req.body.adminNote || null,
                acknowledgedById: req.user.id,
                processedAt: new Date(),
            },
        });

        await sendPush({
            studentId: existing.student.id,
            title: 'Late return request updated',
            body: req.body.adminNote || `Status changed to ${req.body.status}.`,
            data: {
                type: 'LATE_RETURN',
                status: req.body.status,
                lateReturnRequestId: String(existing.id),
            },
        });

        res.json({ success: true, data: resolved });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
