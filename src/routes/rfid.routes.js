// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — RFID Routes
// All RFID endpoints: credentials, readers, verify, transactions
// Mounted at /api/v1/rfid
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { z } = require('zod');
const { authenticate, requireRole } = require('../middleware/auth');
const { authenticateDevice } = require('../middleware/deviceAuth');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/asyncHandler');
const { rfidRateLimit } = require('../middleware/rateLimit');
const { logAction } = require('../services/audit.service');
const rfidService = require('../services/rfid.service');
const readerService = require('../services/rfidReader.service');
const policyService = require('../services/accessPolicy.service');
const { emitRfidEvent, emitReaderStatusChange } = require('../sockets/rfidFeed.socket');

const router = express.Router();

// ─── Zod Schemas ────────────────────────────────────────────────

const assignCredentialSchema = z.object({
    userId: z.string().min(1),
    cardUid: z.string().min(4).max(20),
    printedCardNumber: z.string().optional(),
    batchNumber: z.string().optional(),
    printStatus: z.enum(['PENDING_PRINT', 'PRINTED', 'REPRINT_REQUESTED']).optional(),
    label: z.string().optional(),
    expiresAt: z.string().datetime().optional(),
    credentialType: z.string().optional(),
});

const bulkAssignSchema = z.object({
    items: z.array(z.object({
        enrollmentNo: z.string().min(1),
        cardUid: z.string().min(4).max(20),
        printedCardNumber: z.string().optional(),
        batchNumber: z.string().optional(),
        label: z.string().optional(),
        expiresAt: z.string().optional(),
        credentialType: z.string().optional(),
    })).min(1).max(2000),
    batchNumber: z.string().optional(),
    label: z.string().optional(),
    expiresAt: z.string().optional(),
    credentialType: z.string().optional(),
});

const bulkActionSchema = z.object({
    credentialIds: z.array(z.string().min(1)).min(1).max(2000),
    action: z.enum(['REVOKE', 'SUSPEND', 'ACTIVATE', 'MARK_PRINTED', 'REQUEST_REPRINT']),
    reason: z.string().optional(),
});

const verifySchema = z.object({
    readerId: z.string().min(1),
    cardUid: z.string().min(4).max(20),
    timestamp: z.string().datetime(),
    eventType: z.enum(['ENTRY', 'EXIT', 'ATTENDANCE', 'EVENT_CHECK_IN', 'LIBRARY_CHECK_IN', 'GENERIC_TAP']),
});

const registerReaderSchema = z.object({
    readerId: z.string().min(1).max(64),
    deviceName: z.string().min(1).max(128),
    location: z.string().optional(),
    zone: z.string().optional(),
    deviceSecret: z.string().min(16),
    firmwareVersion: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
});

const updateReaderSchema = z.object({
    deviceName: z.string().min(1).max(128).optional(),
    location: z.string().optional(),
    zone: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    status: z.enum(['ACTIVE', 'MAINTENANCE', 'REVOKED', 'DECOMMISSIONED']).optional(),
});

const heartbeatSchema = z.object({
    readerId: z.string().min(1),
    firmwareVersion: z.string().optional(),
    freeHeapBytes: z.number().optional(),
    wifiRssi: z.number().optional(),
    uptime: z.number().optional(),
    queuedEvents: z.number().optional(),
});

const syncEventsSchema = z.object({
    events: z.array(z.object({
        cardUid: z.string().min(4).max(20),
        timestamp: z.string().datetime(),
        eventType: z.enum(['ENTRY', 'EXIT', 'ATTENDANCE', 'EVENT_CHECK_IN', 'LIBRARY_CHECK_IN', 'GENERIC_TAP']),
    })).min(1).max(100),
});

const revokeSchema = z.object({
    reason: z.string().optional(),
});

const replaceSchema = z.object({
    newCardUid: z.string().min(4).max(20),
    reason: z.string().optional(),
});

const createPolicySchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    roles: z.array(z.string()).optional(),
    studentTypes: z.array(z.string()).optional(),
    zones: z.array(z.string()).optional(),
    readerIds: z.array(z.string()).optional(),
    allowedDays: z.array(z.number().min(1).max(7)).optional(),
    allowedStartTime: z.string().optional(),
    allowedEndTime: z.string().optional(),
    credentialTypes: z.array(z.string()).optional(),
    priority: z.number().optional(),
    effect: z.enum(['ALLOW', 'DENY']).optional(),
});


// ═══════════════════════════════════════════════════════════════
// DEVICE ENDPOINTS (HMAC auth)
// ═══════════════════════════════════════════════════════════════

// ── POST /verify — Primary card tap verification ────────────
router.post('/verify',
    rfidRateLimit,
    authenticateDevice,
    validate(verifySchema),
    asyncHandler(async (req, res) => {
        const { cardUid, eventType, timestamp } = req.body;
        const { readerDbId, readerId, zone } = req.device;

        const result = await rfidService.verifyAccess(
            readerDbId,
            readerId,
            cardUid,
            eventType,
            timestamp,
            zone,
        );

        // Emit real-time event
        try {
            emitRfidEvent(
                {
                    id: result.eventId,
                    cardUid,
                    eventType,
                    accessResult: result.accessGranted ? 'GRANTED' : 'DENIED',
                    denialReason: result.reason || null,
                    serverTimestamp: new Date(),
                },
                result.user || null,
                { readerId, deviceName: req.device.location, zone },
            );
        } catch (emitErr) {
            // Don't fail the request if emit fails
        }

        res.json({
            success: true,
            accessGranted: result.accessGranted,
            ...(result.user && { user: result.user }),
            ...(result.reason && { reason: result.reason }),
            ...(result.cardUid && { cardUid: result.cardUid }),
            eventId: result.eventId,
            message: result.message,
        });
    }),
);

// ── POST /events/sync — Bulk sync offline events ────────────
router.post('/events/sync',
    rfidRateLimit,
    authenticateDevice,
    validate(syncEventsSchema),
    asyncHandler(async (req, res) => {
        const { events } = req.body;
        const { readerDbId, readerId, zone } = req.device;

        const results = await rfidService.syncOfflineEvents(
            readerDbId,
            readerId,
            events,
            zone,
        );

        res.json({
            success: true,
            synced: results.length,
            results,
        });
    }),
);

// ── POST /readers/:id/heartbeat — Reader heartbeat ──────────
router.post('/readers/:id/heartbeat',
    rfidRateLimit,
    authenticateDevice,
    validate(heartbeatSchema),
    asyncHandler(async (req, res) => {
        const result = await readerService.processHeartbeat(
            req.body.readerId,
            {
                ipAddress: req.ip || req.headers['x-forwarded-for'],
                firmwareVersion: req.body.firmwareVersion,
                freeHeapBytes: req.body.freeHeapBytes,
                wifiRssi: req.body.wifiRssi,
                uptime: req.body.uptime,
                queuedEvents: req.body.queuedEvents,
            },
        );

        if (result.statusChanged) {
            try {
                emitReaderStatusChange({
                    readerId: req.body.readerId,
                    isOnline: true,
                    lastHeartbeat: new Date(),
                });
            } catch (e) { /* ignore */ }
        }

        res.json({
            success: true,
            serverTime: result.serverTime,
            readerStatus: result.readerStatus,
            commands: result.commands,
        });
    }),
);


// ═══════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS (JWT auth)
// ═══════════════════════════════════════════════════════════════

// ── RFID Credentials ────────────────────────────────────────────

// POST /credentials — Assign RFID card (Specific / Individual)
router.post('/credentials',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD'),
    validate(assignCredentialSchema),
    asyncHandler(async (req, res) => {
        const credential = await rfidService.assignCredential(
            req.body.userId,
            req.body.cardUid,
            req.user.id,
            {
                printedCardNumber: req.body.printedCardNumber,
                batchNumber: req.body.batchNumber,
                printStatus: req.body.printStatus,
                label: req.body.label,
                expiresAt: req.body.expiresAt,
                credentialType: req.body.credentialType,
            },
        );

        await logAction(req, {
            action: 'RFID_CREDENTIAL_ASSIGNED',
            entity: 'RfidCredential',
            entityId: credential.id,
            newValue: { cardUid: credential.cardUid, userId: req.body.userId, batchNumber: req.body.batchNumber },
        });

        res.status(201).json({ success: true, credential });
    }),
);

// POST /credentials/bulk-assign — Bulk Assign Printed RFID Cards
router.post('/credentials/bulk-assign',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD'),
    validate(bulkAssignSchema),
    asyncHandler(async (req, res) => {
        const results = await rfidService.bulkAssignCredentials(
            req.body.items,
            req.user.id,
            {
                batchNumber: req.body.batchNumber,
                label: req.body.label,
                expiresAt: req.body.expiresAt,
                credentialType: req.body.credentialType,
            },
        );

        await logAction(req, {
            action: 'RFID_CREDENTIALS_BULK_ASSIGNED',
            entity: 'RfidCredential',
            newValue: {
                totalSuccess: results.totalSuccess,
                totalFailed: results.totalFailed,
                batchNumber: req.body.batchNumber,
            },
        });

        res.status(201).json({ success: true, results });
    }),
);

// POST /credentials/bulk-action — Bulk Action on Cards (Revoke, Suspend, Activate, Mark Printed)
router.post('/credentials/bulk-action',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD'),
    validate(bulkActionSchema),
    asyncHandler(async (req, res) => {
        const result = await rfidService.bulkActionCredentials(
            req.body.credentialIds,
            req.body.action,
            req.user.id,
            req.body.reason,
        );

        await logAction(req, {
            action: `RFID_CREDENTIALS_BULK_${req.body.action}`,
            entity: 'RfidCredential',
            newValue: { count: result.count, reason: req.body.reason },
        });

        res.json({ success: true, ...result });
    }),
);

// GET /credentials/export — Export CSV formatted for PVC Card Printing Vendors
router.get('/credentials/export',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD'),
    asyncHandler(async (req, res) => {
        const filters = {
            status: req.query.status || undefined,
            batchNumber: req.query.batchNumber || undefined,
            printStatus: req.query.printStatus || undefined,
            department: req.query.department || undefined,
        };

        const csvData = await rfidService.exportCredentialsForPrinting(filters);

        const filename = `mits_rfid_cards_${filters.batchNumber || 'export'}_${new Date().toISOString().split('T')[0]}.csv`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csvData);
    }),
);

// GET /credentials — List all credentials
router.get('/credentials',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD', 'WARDEN'),
    asyncHandler(async (req, res) => {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const filters = {
            status: req.query.status || undefined,
            userId: req.query.userId || undefined,
            batchNumber: req.query.batchNumber || undefined,
            printStatus: req.query.printStatus || undefined,
            department: req.query.department || undefined,
            search: req.query.search || undefined,
        };

        const result = await rfidService.listCredentials(filters, page, limit);
        res.json({ success: true, ...result });
    }),
);

// GET /credentials/:id — Get credential details
router.get('/credentials/:id',
    authenticate,
    asyncHandler(async (req, res) => {
        const credential = await rfidService.getCredentialById(req.params.id);
        if (!credential) {
            return res.status(404).json({ success: false, error: 'Credential not found' });
        }
        res.json({ success: true, credential });
    }),
);

// PUT /credentials/:id — Update credential
router.put('/credentials/:id',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD'),
    asyncHandler(async (req, res) => {
        const { label, expiresAt } = req.body;
        const prisma = require('../config/database');
        const updated = await prisma.rfidCredential.update({
            where: { id: req.params.id },
            data: {
                ...(label !== undefined && { label }),
                ...(expiresAt !== undefined && { expiresAt: expiresAt ? new Date(expiresAt) : null }),
            },
            include: {
                user: { select: { fullName: true, enrollmentNo: true } },
            },
        });
        res.json({ success: true, credential: updated });
    }),
);

// POST /credentials/:id/revoke
router.post('/credentials/:id/revoke',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD'),
    validate(revokeSchema),
    asyncHandler(async (req, res) => {
        const credential = await rfidService.revokeCredential(
            req.params.id,
            req.user.id,
            req.body.reason,
        );

        await logAction(req, {
            action: 'RFID_CREDENTIAL_REVOKED',
            entity: 'RfidCredential',
            entityId: credential.id,
            newValue: { reason: req.body.reason },
        });

        res.json({ success: true, credential });
    }),
);

// POST /credentials/:id/suspend
router.post('/credentials/:id/suspend',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD', 'WARDEN'),
    asyncHandler(async (req, res) => {
        const credential = await rfidService.suspendCredential(req.params.id);

        await logAction(req, {
            action: 'RFID_CREDENTIAL_SUSPENDED',
            entity: 'RfidCredential',
            entityId: credential.id,
        });

        res.json({ success: true, credential });
    }),
);

// POST /credentials/:id/activate
router.post('/credentials/:id/activate',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD'),
    asyncHandler(async (req, res) => {
        const credential = await rfidService.activateCredential(req.params.id);

        await logAction(req, {
            action: 'RFID_CREDENTIAL_ACTIVATED',
            entity: 'RfidCredential',
            entityId: credential.id,
        });

        res.json({ success: true, credential });
    }),
);

// POST /credentials/:id/replace
router.post('/credentials/:id/replace',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD'),
    validate(replaceSchema),
    asyncHandler(async (req, res) => {
        const credential = await rfidService.replaceCredential(
            req.params.id,
            req.body.newCardUid,
            req.user.id,
            req.body.reason,
        );

        await logAction(req, {
            action: 'RFID_CREDENTIAL_REPLACED',
            entity: 'RfidCredential',
            entityId: credential.id,
            newValue: { newCardUid: req.body.newCardUid, oldId: req.params.id },
        });

        res.json({ success: true, credential });
    }),
);

// ── RFID Readers ────────────────────────────────────────────────

// POST /readers — Register reader
router.post('/readers',
    authenticate,
    requireRole('SUPER_ADMIN'),
    validate(registerReaderSchema),
    asyncHandler(async (req, res) => {
        const reader = await readerService.registerReader(req.body, req.user.id);

        await logAction(req, {
            action: 'RFID_READER_REGISTERED',
            entity: 'RfidReader',
            entityId: reader.id,
            newValue: { readerId: reader.readerId, zone: reader.zone },
        });

        res.status(201).json({ success: true, reader });
    }),
);

// GET /readers — List all readers
router.get('/readers',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD'),
    asyncHandler(async (req, res) => {
        const filters = {
            status: req.query.status || undefined,
            zone: req.query.zone || undefined,
            isOnline: req.query.isOnline !== undefined ? req.query.isOnline === 'true' : undefined,
        };

        const readers = await readerService.listReaders(filters);
        res.json({ success: true, readers });
    }),
);

// GET /readers/status — Reader online/offline status
router.get('/readers/status',
    authenticate,
    asyncHandler(async (req, res) => {
        const statuses = await readerService.getReaderStatuses();
        res.json({ success: true, readers: statuses });
    }),
);

// GET /readers/:id — Reader details
router.get('/readers/:id',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD'),
    asyncHandler(async (req, res) => {
        const reader = await readerService.getReaderById(req.params.id);
        if (!reader) {
            return res.status(404).json({ success: false, error: 'Reader not found' });
        }
        res.json({ success: true, reader });
    }),
);

// PUT /readers/:id — Update reader
router.put('/readers/:id',
    authenticate,
    requireRole('SUPER_ADMIN'),
    validate(updateReaderSchema),
    asyncHandler(async (req, res) => {
        const reader = await readerService.updateReader(req.params.id, req.body);

        await logAction(req, {
            action: 'RFID_READER_UPDATED',
            entity: 'RfidReader',
            entityId: reader.id,
        });

        res.json({ success: true, reader });
    }),
);

// POST /readers/:id/revoke — Revoke reader
router.post('/readers/:id/revoke',
    authenticate,
    requireRole('SUPER_ADMIN'),
    asyncHandler(async (req, res) => {
        const reader = await readerService.revokeReader(req.params.id);

        await logAction(req, {
            action: 'RFID_READER_REVOKED',
            entity: 'RfidReader',
            entityId: reader.id,
        });

        res.json({ success: true, reader });
    }),
);

// ── Transactions ────────────────────────────────────────────────

// GET /transactions — List transactions with filters
router.get('/transactions',
    authenticate,
    asyncHandler(async (req, res) => {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const filters = {
            readerId: req.query.readerId || undefined,
            userId: req.query.userId || undefined,
            cardUid: req.query.cardUid || undefined,
            eventType: req.query.eventType || undefined,
            accessResult: req.query.accessResult || undefined,
            startDate: req.query.startDate || undefined,
            endDate: req.query.endDate || undefined,
        };

        const result = await rfidService.listTransactions(filters, page, limit);
        res.json({ success: true, ...result });
    }),
);

// GET /transactions/:id — Transaction details
router.get('/transactions/:id',
    authenticate,
    asyncHandler(async (req, res) => {
        const txn = await rfidService.getTransactionById(req.params.id);
        if (!txn) {
            return res.status(404).json({ success: false, error: 'Transaction not found' });
        }
        res.json({ success: true, transaction: txn });
    }),
);

// ── Stats ───────────────────────────────────────────────────────

// GET /stats — Dashboard statistics
router.get('/stats',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD'),
    asyncHandler(async (req, res) => {
        const stats = await rfidService.getStats();
        res.json({ success: true, stats });
    }),
);

// ── Access Policies ─────────────────────────────────────────────

// POST /policies — Create policy
router.post('/policies',
    authenticate,
    requireRole('SUPER_ADMIN'),
    validate(createPolicySchema),
    asyncHandler(async (req, res) => {
        const policy = await policyService.createPolicy({
            ...req.body,
            createdBy: req.user.id,
        });

        await logAction(req, {
            action: 'ACCESS_POLICY_CREATED',
            entity: 'AccessPolicy',
            entityId: policy.id,
            newValue: { name: policy.name },
        });

        res.status(201).json({ success: true, policy });
    }),
);

// GET /policies — List policies
router.get('/policies',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD'),
    asyncHandler(async (req, res) => {
        const filters = {
            isActive: req.query.isActive !== undefined ? req.query.isActive === 'true' : undefined,
            zone: req.query.zone || undefined,
        };
        const policies = await policyService.listPolicies(filters);
        res.json({ success: true, policies });
    }),
);

// GET /policies/:id — Policy details
router.get('/policies/:id',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD'),
    asyncHandler(async (req, res) => {
        const policy = await policyService.getPolicyById(req.params.id);
        if (!policy) {
            return res.status(404).json({ success: false, error: 'Policy not found' });
        }
        res.json({ success: true, policy });
    }),
);

// PUT /policies/:id — Update policy
router.put('/policies/:id',
    authenticate,
    requireRole('SUPER_ADMIN'),
    asyncHandler(async (req, res) => {
        const policy = await policyService.updatePolicy(req.params.id, req.body);
        res.json({ success: true, policy });
    }),
);

// ── Cooldown & Anti-Passback Settings ───────────────────────────

const cooldownService = require('../services/cooldown.service');

const updateCooldownSchema = z.object({
    reentryCooldownSeconds: z.number().min(0).max(7200).optional(),
    stayCooldownSeconds: z.number().min(0).max(3600).optional(),
    tapDebounceSeconds: z.number().min(1).max(60).optional(),
    antiPassbackMode: z.enum(['TIMED', 'STRICT', 'DISABLED']).optional(),
    dayScholarExempt: z.boolean().optional(),
    allowEmergencyOverride: z.boolean().optional(),
});

const overrideCooldownSchema = z.object({
    studentId: z.string().min(1),
    reason: z.string().optional(),
});

// GET /cooldown/settings — Get current cooldown configurations
router.get('/cooldown/settings',
    authenticate,
    asyncHandler(async (req, res) => {
        const settings = cooldownService.getCooldownSettings();
        res.json({ success: true, settings });
    }),
);

// PUT /cooldown/settings — Update cooldown configurations
router.put('/cooldown/settings',
    authenticate,
    requireRole('SUPER_ADMIN'),
    validate(updateCooldownSchema),
    asyncHandler(async (req, res) => {
        const updated = cooldownService.updateCooldownSettings(req.body);

        await logAction(req, {
            action: 'UPDATE_COOLDOWN_SETTINGS',
            entity: 'SystemSettings',
            entityId: 'cooldown-settings',
            newValue: req.body,
        });

        res.json({ success: true, settings: updated });
    }),
);

// POST /cooldown/override — Grant emergency temporary cooldown bypass
router.post('/cooldown/override',
    authenticate,
    requireRole('SUPER_ADMIN', 'SECURITY_HEAD', 'WARDEN'),
    validate(overrideCooldownSchema),
    asyncHandler(async (req, res) => {
        const result = cooldownService.grantTemporaryOverride(
            req.body.studentId,
            req.user.id,
            req.body.reason || 'Manual Security Override',
        );

        await logAction(req, {
            action: 'COOLDOWN_OVERRIDE_GRANTED',
            entity: 'Student',
            entityId: req.body.studentId,
            newValue: { reason: req.body.reason },
        });

        res.json({
            success: true,
            message: 'Temporary 15-minute cooldown override granted',
            override: result,
        });
    }),
);

module.exports = router;

