// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Scan Routes
// POST /verify — the core scanning endpoint
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { z } = require('zod');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { scanRateLimit } = require('../middleware/rateLimit');
const scanService = require('../services/scan.service');

const router = express.Router();

const verifyScanSchema = z.object({
    rawToken: z.string().min(1, 'QR token required'),
    gpsLat: z.union([z.string(), z.number()]).optional().nullable(),
    gpsLng: z.union([z.string(), z.number()]).optional().nullable(),
    scanType: z.enum([
        'GATE_ENTRY', 'GATE_EXIT', 'ATTENDANCE', 'LIBRARY_ISSUE',
        'LIBRARY_RETURN', 'MESS', 'CANTEEN_PAYMENT', 'EVENT_CHECKIN',
        'HEALTH_VIEW', 'VOTE_CAST',
    ]),
    gateId: z.string().optional().nullable(),
    metadata: z.record(z.any()).optional().nullable(),
});

// POST /verify
router.post(
    '/verify',
    authenticate,
    requireRole('SECURITY_GUARD', 'HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN'),
    scanRateLimit,
    validate(verifyScanSchema),
    async (req, res, next) => {
        try {
            const result = await scanService.verifyScan({
                rawToken: req.body.rawToken,
                gpsLat: req.body.gpsLat,
                gpsLng: req.body.gpsLng,
                scanType: req.body.scanType,
                operatorId: req.user.id,
                gateId: req.body.gateId,
                metadata: req.body.metadata || {},
            });

            res.json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    }
);

// GET /recent
router.get(
    '/recent',
    authenticate,
    requireRole('DEPT_ADMIN', 'SUPER_ADMIN'),
    async (req, res, next) => {
        try {
            const scans = await scanService.getRecentScans(50);
            res.json({ success: true, data: scans });
        } catch (err) {
            next(err);
        }
    }
);

module.exports = router;
