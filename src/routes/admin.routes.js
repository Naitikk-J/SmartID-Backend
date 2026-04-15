// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Admin Routes
// Admin user CRUD, audit log
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { z } = require('zod');
const bcrypt = require('bcryptjs');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const prisma = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { logAction } = require('../services/audit.service');
const { sendPush } = require('../services/notification.service');

const router = express.Router();

const createAdminSchema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    role: z.enum(['SUPER_ADMIN', 'HOD', 'FACULTY', 'WARDEN', 'SECURITY_GUARD']),
    department: z.preprocess((val) => (val === '' ? null : val), z.string().optional().nullable()),
    module: z.preprocess((val) => (val === '' ? null : val), z.enum(['LIBRARY', 'MESS', 'CANTEEN', 'HEALTH', 'FINANCE', 'EVENTS']).optional().nullable()),
});

const updateAdminSchema = z.object({
    role: z.enum(['SUPER_ADMIN', 'HOD', 'FACULTY', 'WARDEN', 'SECURITY_GUARD']).optional(),
    department: z.preprocess((val) => (val === '' ? null : val), z.string().optional().nullable()),
    module: z.preprocess((val) => (val === '' ? null : val), z.enum(['LIBRARY', 'MESS', 'CANTEEN', 'HEALTH', 'FINANCE', 'EVENTS']).optional().nullable()),
});

const resolveRebindDecisionSchema = z.object({
    decision: z.enum(['APPROVE', 'REJECT']),
    adminNote: z.string().trim().max(240).optional(),
});

function normalizeBoolean(value) {
    return String(value || '').trim().toLowerCase() === 'true' || String(value || '').trim() === '1';
}

async function createStudentAlertFromAdmin({ actorId, studentId, title, body, targetId = null, targetType = 'GENERIC', screen = 'dashboard' }) {
    try {
        const payload = {
            title,
            body,
            targetId,
            targetType,
            screen,
            type: 'STUDENT_ALERT',
        };

        const alert = await prisma.auditLog.create({
            data: {
                actorId,
                action: 'STUDENT_ALERT',
                entity: 'Student',
                entityId: studentId,
                newValue: payload,
            },
        });

        await sendPush({
            studentId,
            title,
            body,
            data: {
                type: 'STUDENT_ALERT',
                alertId: String(alert.id),
                targetId: targetId ? String(targetId) : '',
                targetType,
                screen,
            },
        });

        return alert;
    } catch (err) {
        console.warn('⚠️ Failed to send student alert from admin route:', err.message);
        return null;
    }
}

// ── GET /users — List all admin users ───────────────────────
router.get('/users', authenticate, requireRole('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const users = await prisma.adminUser.findMany({
            select: {
                id: true, name: true, email: true, role: true,
                department: true, module: true, isActive: true,
                lastLogin: true, createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
        });
        res.json({ success: true, data: { users } });
    } catch (err) {
        next(err);
    }
});

// ── POST /users — Create admin user ────────────────────────
router.post('/users', authenticate, requireRole('SUPER_ADMIN'), validate(createAdminSchema), async (req, res, next) => {
    try {
        const passwordHash = await bcrypt.hash(req.body.password, 12);
        const user = await prisma.adminUser.create({
            data: {
                name: req.body.name,
                email: req.body.email,
                passwordHash,
                role: req.body.role,
                department: req.body.department,
                module: req.body.module,
            },
        });

        // Audit log
        await logAction(req, {
            action: 'CREATE_ADMIN_USER',
            entity: 'AdminUser',
            entityId: user.id,
            newValue: { name: user.name, email: user.email, role: user.role }
        }).catch(() => { });

        res.status(201).json({
            success: true,
            data: {
                user: {
                    id: user.id, name: user.name, email: user.email,
                    role: user.role, department: user.department, module: user.module,
                },
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /users/:id — Update role/module/department ────────
router.patch('/users/:id', authenticate, requireRole('SUPER_ADMIN'), validate(updateAdminSchema), async (req, res, next) => {
    try {
        const user = await prisma.adminUser.update({
            where: { id: req.params.id },
            data: req.body,
        });

        await logAction(req, {
            action: 'UPDATE_ADMIN_USER',
            entity: 'AdminUser',
            entityId: user.id,
            newValue: req.body
        }).catch(() => { });

        res.json({
            success: true,
            data: {
                user: {
                    id: user.id, name: user.name, email: user.email,
                    role: user.role, department: user.department, module: user.module,
                },
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /users/:id/toggle — Activate/deactivate ──────────
router.patch('/users/:id/toggle', authenticate, requireRole('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const current = await prisma.adminUser.findUnique({
            where: { id: req.params.id },
        });
        if (!current) throw new AppError('User not found', 404);

        const user = await prisma.adminUser.update({
            where: { id: req.params.id },
            data: { isActive: !current.isActive },
        });

        await logAction(req, {
            action: 'TOGGLE_ADMIN_USER',
            entity: 'AdminUser',
            entityId: user.id,
            newValue: { isActive: user.isActive }
        }).catch(() => { });

        res.json({
            success: true,
            data: { user: { id: user.id, name: user.name, isActive: user.isActive } },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /audit-log ──────────────────────────────────────────
router.get('/audit-log', authenticate, requireRole('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const { page = 1, limit = 50, action, entity } = req.query;
        const where = {};
        if (action) where.action = action;
        if (entity) where.entity = entity;

        const [logs, total] = await Promise.all([
            prisma.auditLog.findMany({
                where,
                include: { actor: { select: { name: true, email: true } } },
                orderBy: { loggedAt: 'desc' },
                skip: (parseInt(page) - 1) * parseInt(limit),
                take: parseInt(limit),
            }),
            prisma.auditLog.count({ where }),
        ]);

        res.json({
            success: true,
            data: {
                logs,
                total,
                page: parseInt(page),
                pages: Math.ceil(total / parseInt(limit)),
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /student-auth-logs ──────────────────────────────────
router.get('/student-auth-logs', authenticate, requireRole('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const { page = 1, limit = 50, action, status, enrollmentNo, deviceId, search, fromDate, toDate, blockedOnly } = req.query;
        const parsedPage = Math.max(parseInt(page, 10) || 1, 1);
        const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

        const where = {};

        if (action) {
            where.action = String(action).trim();
        }

        if (status) {
            where.status = String(status).trim();
        }

        if (normalizeBoolean(blockedOnly)) {
            where.status = 'BLOCKED';
        }

        if (enrollmentNo) {
            where.enrollmentNo = { contains: String(enrollmentNo).trim(), mode: 'insensitive' };
        }

        if (deviceId) {
            where.deviceId = { contains: String(deviceId).trim(), mode: 'insensitive' };
        }

        if (search) {
            const needle = String(search).trim();
            if (needle) {
                where.OR = [
                    { enrollmentNo: { contains: needle, mode: 'insensitive' } },
                    { studentEmail: { contains: needle, mode: 'insensitive' } },
                    { deviceId: { contains: needle, mode: 'insensitive' } },
                    { deviceLabel: { contains: needle, mode: 'insensitive' } },
                    { reason: { contains: needle, mode: 'insensitive' } },
                ];
            }
        }

        if (fromDate || toDate) {
            const createdAt = {};
            if (fromDate) {
                const from = new Date(String(fromDate));
                if (!Number.isNaN(from.getTime())) {
                    createdAt.gte = from;
                }
            }
            if (toDate) {
                const to = new Date(String(toDate));
                if (!Number.isNaN(to.getTime())) {
                    to.setHours(23, 59, 59, 999);
                    createdAt.lte = to;
                }
            }
            if (Object.keys(createdAt).length > 0) {
                where.createdAt = createdAt;
            }
        }

        const [logs, total] = await Promise.all([
            prisma.studentAuthLog.findMany({
                where,
                include: {
                    student: {
                        select: {
                            id: true,
                            fullName: true,
                            enrollmentNo: true,
                            email: true,
                        },
                    },
                },
                orderBy: { createdAt: 'desc' },
                skip: (parsedPage - 1) * parsedLimit,
                take: parsedLimit,
            }),
            prisma.studentAuthLog.count({ where }),
        ]);

        res.json({
            success: true,
            data: {
                logs,
                total,
                page: parsedPage,
                pages: Math.ceil(total / parsedLimit),
                limit: parsedLimit,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /device-rebind-requests ─────────────────────────────
router.get('/device-rebind-requests', authenticate, requireRole('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const { page = 1, limit = 50, status = 'PENDING', search } = req.query;
        const parsedPage = Math.max(parseInt(page, 10) || 1, 1);
        const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

        const where = {};
        if (status) {
            where.status = String(status).trim().toUpperCase();
        }

        if (search) {
            const needle = String(search).trim();
            if (needle) {
                const matchingStudents = await prisma.student.findMany({
                    where: {
                        OR: [
                            { enrollmentNo: { contains: needle, mode: 'insensitive' } },
                            { fullName: { contains: needle, mode: 'insensitive' } },
                            { email: { contains: needle, mode: 'insensitive' } },
                        ],
                    },
                    select: { id: true },
                    take: 200,
                });
                const studentIds = matchingStudents.map((item) => item.id);

                where.OR = [
                    { requestedDeviceId: { contains: needle, mode: 'insensitive' } },
                    { requestedLabel: { contains: needle, mode: 'insensitive' } },
                    ...(studentIds.length > 0 ? [{ studentId: { in: studentIds } }] : []),
                ];
            }
        }

        const [requests, total] = await Promise.all([
            prisma.deviceRebindRequest.findMany({
                where,
                include: {
                    student: {
                        select: {
                            id: true,
                            fullName: true,
                            enrollmentNo: true,
                            email: true,
                            linkedDeviceId: true,
                            linkedDeviceLabel: true,
                            linkedDevicePlatform: true,
                        },
                    },
                    processedBy: {
                        select: {
                            id: true,
                            name: true,
                            email: true,
                        },
                    },
                },
                orderBy: { requestedAt: 'desc' },
                skip: (parsedPage - 1) * parsedLimit,
                take: parsedLimit,
            }),
            prisma.deviceRebindRequest.count({ where }),
        ]);

        res.json({
            success: true,
            data: {
                requests,
                total,
                page: parsedPage,
                pages: Math.ceil(total / parsedLimit),
                limit: parsedLimit,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /device-rebind-requests/:id/decision ─────────────
router.patch('/device-rebind-requests/:id/decision', authenticate, requireRole('SUPER_ADMIN'), validate(resolveRebindDecisionSchema), async (req, res, next) => {
    try {
        const requestRecord = await prisma.deviceRebindRequest.findUnique({
            where: { id: req.params.id },
            include: {
                student: {
                    select: {
                        id: true,
                        fullName: true,
                        enrollmentNo: true,
                        email: true,
                        linkedDeviceId: true,
                    },
                },
            },
        });

        if (!requestRecord) {
            throw new AppError('Rebind request not found', 404, 'DEVICE_REBIND_REQUEST_NOT_FOUND');
        }

        if (requestRecord.status !== 'PENDING') {
            throw new AppError('Rebind request already processed', 409, 'DEVICE_REBIND_REQUEST_ALREADY_PROCESSED');
        }

        const decision = req.body.decision;
        const adminNote = (req.body.adminNote || '').trim() || null;

        if (decision === 'REJECT') {
            const rejected = await prisma.deviceRebindRequest.update({
                where: { id: requestRecord.id },
                data: {
                    status: 'REJECTED',
                    adminNote,
                    processedById: req.user.id,
                    processedAt: new Date(),
                },
            });

            await prisma.studentAuthLog.create({
                data: {
                    studentId: requestRecord.studentId,
                    studentEmail: requestRecord.student?.email || null,
                    enrollmentNo: requestRecord.student?.enrollmentNo || null,
                    action: 'DEVICE_REBIND_REJECTED',
                    status: 'REJECTED',
                    reason: adminNote || 'REJECTED_BY_ADMIN',
                    deviceId: requestRecord.requestedDeviceId,
                    deviceLabel: requestRecord.requestedLabel,
                    devicePlatform: requestRecord.requestedPlatform,
                    metadata: {
                        requestId: requestRecord.id,
                        processedBy: req.user.id,
                    },
                },
            }).catch(() => { });

            await createStudentAlertFromAdmin({
                actorId: req.user.id,
                studentId: requestRecord.studentId,
                title: 'Device rebind request rejected',
                body: adminNote || 'Admin rejected your device rebind request.',
                targetId: requestRecord.id,
            });

            await logAction(req, {
                action: 'DEVICE_REBIND_REQUEST_REJECTED',
                entity: 'DeviceRebindRequest',
                entityId: requestRecord.id,
                newValue: { studentId: requestRecord.studentId, requestedDeviceId: requestRecord.requestedDeviceId, adminNote },
            }).catch(() => { });

            return res.json({ success: true, data: { request: rejected } });
        }

        const conflictingStudent = await prisma.student.findFirst({
            where: {
                linkedDeviceId: requestRecord.requestedDeviceId,
                NOT: { id: requestRecord.studentId },
            },
            select: {
                id: true,
                enrollmentNo: true,
                fullName: true,
            },
        });

        if (conflictingStudent) {
            throw new AppError(
                `Cannot approve: device already linked to ${conflictingStudent.enrollmentNo}.`,
                409,
                'DEVICE_ALREADY_LINKED',
            );
        }

        const now = new Date();
        const [approvedRequest, updatedStudent] = await prisma.$transaction([
            prisma.deviceRebindRequest.update({
                where: { id: requestRecord.id },
                data: {
                    status: 'APPROVED',
                    adminNote,
                    processedById: req.user.id,
                    processedAt: now,
                },
            }),
            prisma.student.update({
                where: { id: requestRecord.studentId },
                data: {
                    linkedDeviceId: requestRecord.requestedDeviceId,
                    linkedDeviceLabel: requestRecord.requestedLabel || requestRecord.student?.linkedDeviceLabel || null,
                    linkedDevicePlatform: requestRecord.requestedPlatform || requestRecord.student?.linkedDevicePlatform || null,
                    deviceLinkedAt: now,
                },
                select: {
                    id: true,
                    email: true,
                    enrollmentNo: true,
                    linkedDeviceId: true,
                    linkedDeviceLabel: true,
                    linkedDevicePlatform: true,
                },
            }),
        ]);

        await prisma.studentAuthLog.create({
            data: {
                studentId: updatedStudent.id,
                studentEmail: updatedStudent.email,
                enrollmentNo: updatedStudent.enrollmentNo,
                action: 'DEVICE_REBIND_APPROVED',
                status: 'SUCCESS',
                reason: adminNote || null,
                deviceId: updatedStudent.linkedDeviceId,
                deviceLabel: updatedStudent.linkedDeviceLabel,
                devicePlatform: updatedStudent.linkedDevicePlatform,
                metadata: {
                    requestId: requestRecord.id,
                    processedBy: req.user.id,
                },
            },
        }).catch(() => { });

        await createStudentAlertFromAdmin({
            actorId: req.user.id,
            studentId: updatedStudent.id,
            title: 'Device rebind approved',
            body: 'Admin approved your device rebind request. You can now login from the new device.',
            targetId: requestRecord.id,
        });

        await logAction(req, {
            action: 'DEVICE_REBIND_REQUEST_APPROVED',
            entity: 'DeviceRebindRequest',
            entityId: requestRecord.id,
            newValue: {
                studentId: updatedStudent.id,
                requestedDeviceId: updatedStudent.linkedDeviceId,
                adminNote,
            },
        }).catch(() => { });

        res.json({
            success: true,
            data: {
                request: approvedRequest,
                student: updatedStudent,
            },
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
