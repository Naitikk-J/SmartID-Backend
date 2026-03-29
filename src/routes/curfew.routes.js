
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
router.post('/', authenticate, requireRole('SUPER_ADMIN', 'WARDEN'), async (req, res) => {
    try {
        const newRule = await createCurfewRule(req.body);
        res.status(201).json({ success: true, data: newRule });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// Update a curfew rule
router.put('/:id', authenticate, requireRole('SUPER_ADMIN', 'WARDEN'), async (req, res) => {
    try {
        const updatedRule = await updateCurfewRule(req.params.id, req.body);
        res.json({ success: true, data: updatedRule });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// Delete a curfew rule
router.delete('/:id', authenticate, requireRole('SUPER_ADMIN', 'WARDEN'), async (req, res) => {
    try {
        await deleteCurfewRule(req.params.id);
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
