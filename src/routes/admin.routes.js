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
        const { page = 1, limit = 50, action, status, enrollmentNo, deviceId, search } = req.query;
        const parsedPage = Math.max(parseInt(page, 10) || 1, 1);
        const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

        const where = {};

        if (action) {
            where.action = String(action).trim();
        }

        if (status) {
            where.status = String(status).trim();
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

module.exports = router;
