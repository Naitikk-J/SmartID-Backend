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

const revokeDeviceBindingSchema = z.object({
    email: z.string().trim().email(),
    reason: z.string().trim().max(240).optional(),
});

function normalizeBoolean(value) {
    return String(value || '').trim().toLowerCase() === 'true' || String(value || '').trim() === '1';
}

function resolveDirectionalEvent(scanEvent) {
    const metadataDirection = scanEvent?.metadata?.direction;
    if (metadataDirection === 'ENTRY' || metadataDirection === 'EXIT') return metadataDirection;

    const metadataEventType = scanEvent?.metadata?.event_type;
    if (metadataEventType === 'ENTRY' || metadataEventType === 'EXIT') return metadataEventType;

    if (scanEvent?.scanType === 'GATE_ENTRY') return 'ENTRY';
    if (scanEvent?.scanType === 'GATE_EXIT') return 'EXIT';
    return null;
}

function parseRuleTimeOnDate(baseDate, hhmm) {
    const [hh, mm] = String(hhmm || '21:00').split(':').map((value) => Number(value || 0));
    const date = new Date(baseDate);
    date.setHours(hh, mm, 0, 0);
    return date;
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
router.get('/student-auth-logs', authenticate, requireRole('SUPER_ADMIN', 'WARDEN'), async (req, res, next) => {
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

// ── GET /device-bindings ────────────────────────────────────
router.get('/device-bindings', authenticate, requireRole('SUPER_ADMIN', 'WARDEN'), async (req, res, next) => {
    try {
        const { page = 1, limit = 50, search, deviceId } = req.query;
        const parsedPage = Math.max(parseInt(page, 10) || 1, 1);
        const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

        const whereClauses = [{ linkedDeviceId: { not: null } }];

        const trimmedDeviceId = String(deviceId || '').trim();
        if (trimmedDeviceId) {
            whereClauses.push({
                linkedDeviceId: {
                    contains: trimmedDeviceId,
                    mode: 'insensitive',
                },
            });
        }

        const needle = String(search || '').trim();
        if (needle) {
            whereClauses.push({
                OR: [
                    { enrollmentNo: { contains: needle, mode: 'insensitive' } },
                    { fullName: { contains: needle, mode: 'insensitive' } },
                    { email: { contains: needle, mode: 'insensitive' } },
                    { linkedDeviceId: { contains: needle, mode: 'insensitive' } },
                    { linkedDeviceLabel: { contains: needle, mode: 'insensitive' } },
                    { linkedDevicePlatform: { contains: needle, mode: 'insensitive' } },
                ],
            });
        }

        const where = whereClauses.length === 1 ? whereClauses[0] : { AND: whereClauses };

        const [bindings, total] = await Promise.all([
            prisma.student.findMany({
                where,
                select: {
                    id: true,
                    fullName: true,
                    enrollmentNo: true,
                    email: true,
                    linkedDeviceId: true,
                    linkedDeviceLabel: true,
                    linkedDevicePlatform: true,
                    deviceLinkedAt: true,
                    lastLoginAt: true,
                    lastLogoutAt: true,
                },
                orderBy: [
                    { deviceLinkedAt: 'desc' },
                    { updatedAt: 'desc' },
                ],
                skip: (parsedPage - 1) * parsedLimit,
                take: parsedLimit,
            }),
            prisma.student.count({ where }),
        ]);

        res.json({
            success: true,
            data: {
                bindings,
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

// ── PATCH /device-bindings/revoke ───────────────────────────
router.patch('/device-bindings/revoke', authenticate, requireRole('SUPER_ADMIN', 'WARDEN'), validate(revokeDeviceBindingSchema), async (req, res, next) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const reason = String(req.body.reason || '').trim() || 'REVOKED_BY_ADMIN';

        const student = await prisma.student.findUnique({
            where: { email },
            select: {
                id: true,
                fullName: true,
                enrollmentNo: true,
                email: true,
                linkedDeviceId: true,
                linkedDeviceLabel: true,
                linkedDevicePlatform: true,
            },
        });

        if (!student) {
            throw new AppError('Student not found for this email', 404, 'STUDENT_NOT_FOUND');
        }

        if (!student.linkedDeviceId) {
            throw new AppError('No active device binding found for this email', 409, 'DEVICE_BINDING_NOT_FOUND');
        }

        const previousBinding = {
            deviceId: student.linkedDeviceId,
            deviceLabel: student.linkedDeviceLabel,
            devicePlatform: student.linkedDevicePlatform,
        };

        const updatedStudent = await prisma.student.update({
            where: { id: student.id },
            data: {
                linkedDeviceId: null,
                linkedDeviceLabel: null,
                linkedDevicePlatform: null,
                deviceLinkedAt: null,
            },
            select: {
                id: true,
                fullName: true,
                enrollmentNo: true,
                email: true,
                linkedDeviceId: true,
                linkedDeviceLabel: true,
                linkedDevicePlatform: true,
                deviceLinkedAt: true,
            },
        });

        await prisma.studentAuthLog.create({
            data: {
                studentId: student.id,
                studentEmail: student.email,
                enrollmentNo: student.enrollmentNo,
                action: 'DEVICE_BINDING_REVOKED_BY_ADMIN',
                status: 'SUCCESS',
                reason,
                deviceId: previousBinding.deviceId,
                deviceLabel: previousBinding.deviceLabel,
                devicePlatform: previousBinding.devicePlatform,
                metadata: {
                    revokedBy: req.user.id,
                    revokedByRole: req.user.role,
                },
            },
        }).catch(() => { });

        await createStudentAlertFromAdmin({
            actorId: req.user.id,
            studentId: student.id,
            title: 'Device binding revoked',
            body: 'Your linked device was revoked by admin. Please login again to bind a new device.',
            targetType: 'AUTH',
            screen: 'login',
        });

        await logAction(req, {
            action: 'REVOKE_STUDENT_DEVICE_BINDING',
            entity: 'Student',
            entityId: student.id,
            newValue: {
                email,
                reason,
                previousBinding,
            },
        }).catch(() => { });

        res.json({
            success: true,
            data: {
                student: updatedStudent,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /device-rebind-requests ─────────────────────────────
router.get('/device-rebind-requests', authenticate, requireRole('SUPER_ADMIN', 'WARDEN'), async (req, res, next) => {
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
router.patch('/device-rebind-requests/:id/decision', authenticate, requireRole('SUPER_ADMIN', 'WARDEN'), validate(resolveRebindDecisionSchema), async (req, res, next) => {
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

// ── GET /hosteller-insights ─────────────────────────────────
router.get('/hosteller-insights', authenticate, requireRole('SUPER_ADMIN', 'HOD', 'WARDEN', 'FACULTY', 'SECURITY_GUARD'), async (req, res, next) => {
    try {
        const now = new Date();
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);

        const weekStart = new Date(todayStart);
        weekStart.setDate(weekStart.getDate() - 6);

        const [curfewRules, weeklyEvents, pendingLateReturns] = await Promise.all([
            prisma.curfewRule.findMany({
                where: {
                    isActive: true,
                    studentType: {
                        in: ['HOSTELLER_BOYS', 'HOSTELLER_GIRLS'],
                    },
                },
                select: {
                    studentType: true,
                    startTime: true,
                },
            }),
            prisma.scanEvent.findMany({
                where: {
                    scannedAt: { gte: weekStart },
                    scanType: { in: ['ACCESS_SCAN', 'GATE_ENTRY', 'GATE_EXIT'] },
                    student: {
                        studentType: { in: ['HOSTELLER_BOYS', 'HOSTELLER_GIRLS'] },
                    },
                },
                select: {
                    id: true,
                    scanType: true,
                    scannedAt: true,
                    metadata: true,
                    student: {
                        select: {
                            id: true,
                            fullName: true,
                            enrollmentNo: true,
                            department: true,
                            studentType: true,
                        },
                    },
                },
                orderBy: { scannedAt: 'desc' },
                take: 5000,
            }),
            prisma.lateReturnRequest.findMany({
                where: { status: 'PENDING' },
                include: {
                    student: {
                        select: {
                            id: true,
                            fullName: true,
                            enrollmentNo: true,
                            department: true,
                            studentType: true,
                        },
                    },
                },
                orderBy: { requestedAt: 'desc' },
                take: 100,
            }),
        ]);

        const ruleMap = new Map(curfewRules.map((rule) => [rule.studentType, rule.startTime]));
        const dayStats = new Map();
        const studentStats = new Map();

        for (const event of weeklyEvents) {
            const direction = resolveDirectionalEvent(event);
            if (!direction || !event.student?.id) continue;

            const eventTime = new Date(event.scannedAt);
            const dayKey = eventTime.toISOString().slice(0, 10);
            const existingDay = dayStats.get(dayKey) || { entries: 0, exits: 0 };
            if (direction === 'ENTRY') existingDay.entries += 1;
            if (direction === 'EXIT') existingDay.exits += 1;
            dayStats.set(dayKey, existingDay);

            const existingStudent = studentStats.get(event.student.id) || {
                student: event.student,
                totalEvents: 0,
                lateEntries: 0,
                lateExits: 0,
                unusualMovement: 0,
                riskScore: 0,
            };

            existingStudent.totalEvents += 1;

            const studentCurfew = ruleMap.get(event.student.studentType) || '21:00';
            const curfewStartForDay = parseRuleTimeOnDate(eventTime, studentCurfew);
            const isAfterCurfew = eventTime.getTime() >= curfewStartForDay.getTime();

            if (direction === 'ENTRY' && isAfterCurfew) existingStudent.lateEntries += 1;
            if (direction === 'EXIT' && isAfterCurfew) existingStudent.lateExits += 1;
            if (event?.metadata?.suspicious === true) existingStudent.unusualMovement += 1;

            existingStudent.riskScore = (existingStudent.lateEntries * 2)
                + existingStudent.lateExits
                + (existingStudent.unusualMovement * 3);

            studentStats.set(event.student.id, existingStudent);
        }

        const weeklyTrend = Array.from(dayStats.entries())
            .map(([date, stat]) => ({ date, ...stat }))
            .sort((a, b) => a.date.localeCompare(b.date));

        const todayKey = now.toISOString().slice(0, 10);
        const todayStat = dayStats.get(todayKey) || { entries: 0, exits: 0 };

        const highRiskStudents = Array.from(studentStats.values())
            .filter((item) => item.riskScore >= 3 || item.lateEntries >= 2 || item.unusualMovement >= 1)
            .sort((a, b) => b.riskScore - a.riskScore)
            .slice(0, 50);

        res.json({
            success: true,
            data: {
                daily: {
                    date: todayKey,
                    entries: todayStat.entries,
                    exits: todayStat.exits,
                },
                weekly: {
                    from: weekStart,
                    to: now,
                    trend: weeklyTrend,
                },
                highRiskStudents,
                lateReturn: {
                    pendingCount: pendingLateReturns.length,
                    pendingRequests: pendingLateReturns,
                },
            },
        });
    } catch (err) {
        next(err);
    }
});

router.patch('/users/:id', authenticate, requireRole('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const { role, module, department } = req.body;
        const updateData = {};
        if (role) updateData.role = role;
        if (module !== undefined) updateData.module = module || null;
        if (department !== undefined) updateData.department = department || null;

        const user = await prisma.adminUser.update({
            where: { id },
            data: updateData,
            select: { id: true, name: true, email: true, role: true, module: true, department: true, isActive: true },
        });
        res.json({ success: true, data: { user } });
    } catch (err) {
        next(err);
    }
});

router.post('/users/assign-role', authenticate, requireRole('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const { email, role, module, department } = req.body;
        if (!email || !role) {
            return res.status(400).json({ success: false, error: 'Email and role are required' });
        }

        const existingUser = await prisma.adminUser.findUnique({ where: { email } });
        if (!existingUser) {
            const newUser = await prisma.adminUser.create({
                data: {
                    email,
                    name: email.split('@')[0],
                    passwordHash: 'google-auth-placeholder',
                    role,
                    module: module || null,
                    department: department || null,
                    isActive: true,
                },
                select: { id: true, name: true, email: true, role: true, module: true, department: true, isActive: true },
            });
            return res.json({ success: true, data: { user: newUser, created: true } });
        }

        const updated = await prisma.adminUser.update({
            where: { email },
            data: {
                role,
                module: module || null,
                department: department || null,
                isActive: true,
            },
            select: { id: true, name: true, email: true, role: true, module: true, department: true, isActive: true },
        });
        res.json({ success: true, data: { user: updated, created: false } });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
