// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Curfew Rule routes
//
// Curfew rules govern hosteller exit/entry permissions, which means
// any mutation here is security-sensitive: a deleted or relaxed rule
// could let a student leave campus without authorisation, and an
// over-strict rule could lock students in. Every write therefore
// goes through `audit.service.logAction` with the before/after
// snapshot for forensic traceability.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const {
    getCurfewRules,
    updateCurfewRule,
    createCurfewRule,
    deleteCurfewRule,
    getCurfewRuleById,
} = require('../services/curfew.service');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAction } = require('../services/audit.service');
const { asyncHandler } = require('../middleware/asyncHandler');

// Get all curfew rules (faculty+wardens+admins)
router.get('/', authenticate, requireRole('FACULTY', 'WARDEN', 'HOD', 'SUPER_ADMIN'), async (req, res) => {
    try {
        const rules = await getCurfewRules();
        res.json({ success: true, data: rules });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get a single curfew rule by ID
router.get('/:id', authenticate, requireRole('FACULTY', 'WARDEN', 'HOD', 'SUPER_ADMIN'), async (req, res) => {
    try {
        const rule = await getCurfewRuleById(req.params.id);
        if (!rule) {
            return res.status(404).json({ success: false, error: 'Rule not found' });
        }
        res.json({ success: true, data: rule });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create a new curfew rule
router.post(
    '/',
    authenticate,
    requireRole('SUPER_ADMIN', 'WARDEN'),
    asyncHandler(async (req, res) => {
        try {
            const newRule = await createCurfewRule(req.body);
            // Best-effort audit — never blocks the response.
            logAction(req, {
                action: 'CURFEW_RULE_CREATE',
                entity: 'CurfewRule',
                entityId: newRule?.id || null,
                newValue: newRule,
            }).catch(() => { /* logged by audit service */ });
            res.status(201).json({ success: true, data: newRule });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    }),
);

// Update a curfew rule
router.put(
    '/:id',
    authenticate,
    requireRole('SUPER_ADMIN', 'WARDEN'),
    asyncHandler(async (req, res) => {
        try {
            // Snapshot the rule BEFORE mutation so the audit row has a
            // proper diff. If the lookup fails we still proceed — the
            // updateCurfewRule call will throw a not-found cleanly.
            const oldRule = await getCurfewRuleById(req.params.id).catch(() => null);
            const updatedRule = await updateCurfewRule(req.params.id, req.body);
            logAction(req, {
                action: 'CURFEW_RULE_UPDATE',
                entity: 'CurfewRule',
                entityId: req.params.id,
                oldValue: oldRule,
                newValue: updatedRule,
            }).catch(() => {});
            res.json({ success: true, data: updatedRule });
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    }),
);

// Delete a curfew rule
router.delete(
    '/:id',
    authenticate,
    requireRole('SUPER_ADMIN', 'WARDEN'),
    asyncHandler(async (req, res) => {
        try {
            const oldRule = await getCurfewRuleById(req.params.id).catch(() => null);
            await deleteCurfewRule(req.params.id);
            logAction(req, {
                action: 'CURFEW_RULE_DELETE',
                entity: 'CurfewRule',
                entityId: req.params.id,
                oldValue: oldRule,
            }).catch(() => {});
            res.status(204).send();
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }),
);

module.exports = router;
