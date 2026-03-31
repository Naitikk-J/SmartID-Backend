// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Alerts Routes
// Admin -> student targeted alerts + student inbox
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { z } = require('zod');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const prisma = require('../config/database');
const { sendPush } = require('../services/notification.service');

const router = express.Router();

const sendAlertSchema = z.object({
    studentId: z.string().min(1),
    title: z.string().min(3),
    body: z.string().min(3),
    targetId: z.string().optional().nullable(),
    targetType: z.enum(['SCAN_EVENT', 'PINK_SLIP', 'GENERIC']).optional().nullable(),
    screen: z.enum(['activity', 'pink-slip', 'dashboard']).optional().nullable(),
});

// Admin sends targeted alert to a student.
router.post(
    '/student',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD', 'WARDEN', 'FACULTY', 'SECURITY_GUARD'),
    validate(sendAlertSchema),
    async (req, res, next) => {
        try {
            const payload = {
                title: req.body.title,
                body: req.body.body,
                targetId: req.body.targetId || null,
                targetType: req.body.targetType || 'GENERIC',
                screen: req.body.screen || 'dashboard',
                type: 'STUDENT_ALERT',
            };

            const alert = await prisma.auditLog.create({
                data: {
                    actorId: req.user.id,
                    action: 'STUDENT_ALERT',
                    entity: 'Student',
                    entityId: req.body.studentId,
                    newValue: payload,
                },
            });

            // Optional push channel if FCM is configured.
            await sendPush({
                studentId: req.body.studentId,
                title: req.body.title,
                body: req.body.body,
                data: {
                    type: 'STUDENT_ALERT',
                    alertId: String(alert.id),
                    targetId: req.body.targetId ? String(req.body.targetId) : '',
                    targetType: req.body.targetType || 'GENERIC',
                    screen: req.body.screen || 'dashboard',
                },
            });

            res.status(201).json({
                success: true,
                data: {
                    id: alert.id,
                    ...payload,
                    studentId: req.body.studentId,
                    sentAt: alert.loggedAt,
                },
            });
        } catch (err) {
            next(err);
        }
    }
);

// Student inbox for targeted alerts.
router.get('/me', authenticate, requireRole('STUDENT'), async (req, res, next) => {
    try {
        const limit = Math.min(parseInt(String(req.query.limit || '20'), 10), 100);

        const alerts = await prisma.auditLog.findMany({
            where: {
                action: 'STUDENT_ALERT',
                entity: 'Student',
                entityId: req.user.id,
            },
            include: {
                actor: {
                    select: {
                        id: true,
                        name: true,
                        role: true,
                    },
                },
            },
            orderBy: { loggedAt: 'desc' },
            take: limit,
        });

        res.json({
            success: true,
            data: alerts.map((a) => ({
                id: a.id,
                title: a.newValue?.title || 'Alert',
                body: a.newValue?.body || '',
                targetId: a.newValue?.targetId || null,
                targetType: a.newValue?.targetType || 'GENERIC',
                screen: a.newValue?.screen || 'dashboard',
                sentAt: a.loggedAt,
                sender: a.actor,
            })),
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
