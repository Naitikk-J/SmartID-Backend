// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Gate Routes
// Exit rules, exit history, manual overrides
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { z } = require('zod');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const exitService = require('../services/exit.service');
const { emitExitRuleChange } = require('../sockets/scanFeed.socket');

const router = express.Router();

const updateRuleSchema = z.object({
    studentType: z.enum(['DAY_SCHOLAR', 'HOSTELLER_BOYS', 'HOSTELLER_GIRLS']),
    dayOfWeek: z.number().int().min(1).max(7),
    maxExits: z.number().int().min(-1),
});

const overrideSchema = z.object({
    studentId: z.string().min(1),
    gateId: z.string().min(1),
    direction: z.enum(['EXIT', 'ENTRY']),
});

// ── GET /exit-rules ─────────────────────────────────────────
router.get('/exit-rules', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'WARDEN'), async (req, res, next) => {
    try {
        const grid = await exitService.getExitRulesGrid();
        res.json({ success: true, data: { rules: grid } });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /exit-rules ───────────────────────────────────────
router.patch('/exit-rules', authenticate, requireRole('HOD', 'SUPER_ADMIN'), validate(updateRuleSchema), async (req, res, next) => {
    try {
        const rule = await exitService.updateExitRule(
            req.body.studentType,
            req.body.dayOfWeek,
            req.body.maxExits,
            req.user.id
        );

        // Emit updated rules to dashboard
        const updatedGrid = await exitService.getExitRulesGrid();
        emitExitRuleChange(updatedGrid);

        res.json({ success: true, data: { rule } });
    } catch (err) {
        next(err);
    }
});

// ── GET /exit-history ───────────────────────────────────────
router.get('/exit-history', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'WARDEN'), async (req, res, next) => {
    try {
        const result = await exitService.getExitHistory(req.query);
        res.json({
            success: true,
            data: {
                ...result,
                events: result.events.map((e) => ({ ...e, id: e.id.toString() })),
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── POST /exit-override — manual exit/entry ─────────────────
router.post('/exit-override', authenticate, requireRole('HOD', 'SUPER_ADMIN'), validate(overrideSchema), async (req, res, next) => {
    try {
        const event = await exitService.recordExitEvent(
            req.body.studentId,
            req.body.gateId,
            req.body.direction
        );
        // Mark as override
        const prisma = require('../config/database');
        await prisma.exitEvent.update({
            where: { id: event.id },
            data: { overrideById: req.user.id },
        });

        res.json({
            success: true,
            data: { event },
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
