const express = require('express');
const { z } = require('zod');

const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { logAction } = require('../services/audit.service');
const {
    getGeofencingSettings,
    updateGeofencingSettings,
} = require('../services/geofencing-settings.service');

const router = express.Router();

const updateGeofencingSchema = z.object({
    campusCenterLat: z.number().min(-90).max(90).optional(),
    campusCenterLng: z.number().min(-180).max(180).optional(),
    campusRadiusMetres: z.number().min(100).max(50000).optional(),
    attendanceRadiusMetres: z.number().min(20).max(50000).optional(),
    eventScanRadiusMetres: z.number().min(100).max(50000).optional(),
    accessQrTtlSeconds: z.number().int().min(15).max(120).optional(),
    accessRequireGeofence: z.boolean().optional(),
}).refine((payload) => Object.keys(payload).length > 0, {
    message: 'At least one setting field is required',
});

router.get(
    '/settings',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD', 'WARDEN', 'FACULTY', 'SECURITY_GUARD'),
    async (req, res, next) => {
        try {
            return res.json({
                success: true,
                data: {
                    settings: getGeofencingSettings(),
                    persistence: 'RUNTIME_MEMORY',
                },
            });
        } catch (err) {
            next(err);
        }
    },
);

router.put(
    '/settings',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD', 'WARDEN'),
    validate(updateGeofencingSchema),
    async (req, res, next) => {
        try {
            const previous = getGeofencingSettings();
            const settings = updateGeofencingSettings(req.body);

            await logAction(req, {
                action: 'GEOFENCING_SETTINGS_UPDATED',
                entity: 'GeofencingSettings',
                entityId: 'runtime',
                oldValue: previous,
                newValue: settings,
            });

            return res.json({
                success: true,
                data: {
                    settings,
                    persistence: 'RUNTIME_MEMORY',
                },
            });
        } catch (err) {
            next(err);
        }
    },
);

module.exports = router;
