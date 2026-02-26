// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Events Routes
// Campus event management (fest/exam override modes)
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { z } = require('zod');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const prisma = require('../config/database');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

const createEventSchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    eventDate: z.string().datetime().or(z.string()),
    startTime: z.string().datetime().or(z.string()),
    endTime: z.string().datetime().or(z.string()),
    exitMode: z.enum(['SINGLE', 'UNLIMITED', 'CUSTOM']),
    customMax: z.number().int().positive().optional().nullable(),
    appliesTo: z.array(z.string()).default(['ALL']),
    gateIds: z.array(z.string()).default([]),
});

const updateEventSchema = createEventSchema.partial();

// ── GET / — List all events ─────────────────────────────────
router.get('/', authenticate, requireRole('DEPT_ADMIN', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const events = await prisma.campusEvent.findMany({
            orderBy: { eventDate: 'desc' },
            include: { createdBy: { select: { name: true } } },
        });
        res.json({ success: true, data: { events } });
    } catch (err) {
        next(err);
    }
});

// ── POST / — Create event ───────────────────────────────────
router.post('/', authenticate, requireRole('DEPT_ADMIN', 'SUPER_ADMIN'), validate(createEventSchema), async (req, res, next) => {
    try {
        const event = await prisma.campusEvent.create({
            data: {
                ...req.body,
                eventDate: new Date(req.body.eventDate),
                startTime: new Date(req.body.startTime),
                endTime: new Date(req.body.endTime),
                createdById: req.user.id,
            },
        });
        res.status(201).json({ success: true, data: { event } });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /:id — Update event ───────────────────────────────
router.patch('/:id', authenticate, requireRole('DEPT_ADMIN', 'SUPER_ADMIN'), validate(updateEventSchema), async (req, res, next) => {
    try {
        const data = { ...req.body };
        if (data.eventDate) data.eventDate = new Date(data.eventDate);
        if (data.startTime) data.startTime = new Date(data.startTime);
        if (data.endTime) data.endTime = new Date(data.endTime);

        const event = await prisma.campusEvent.update({
            where: { id: req.params.id },
            data,
        });
        res.json({ success: true, data: { event } });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /:id/toggle — Activate/deactivate event ──────────
router.patch('/:id/toggle', authenticate, requireRole('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const current = await prisma.campusEvent.findUnique({
            where: { id: req.params.id },
        });
        if (!current) throw new AppError('Event not found', 404);

        const event = await prisma.campusEvent.update({
            where: { id: req.params.id },
            data: { isActive: !current.isActive },
        });
        res.json({ success: true, data: { event } });
    } catch (err) {
        next(err);
    }
});

// ── DELETE /:id — Soft delete ───────────────────────────────
router.delete('/:id', authenticate, requireRole('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const event = await prisma.campusEvent.update({
            where: { id: req.params.id },
            data: { isActive: false },
        });
        res.json({ success: true, data: { event, message: 'Event deactivated' } });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
