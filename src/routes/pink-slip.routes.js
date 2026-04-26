// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Pink Slip (Leave Management) Routes
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { z } = require('zod');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const prisma = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { logAction } = require('../services/audit.service');

const router = express.Router();
const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;
const TICKET_CODE_REGEX = /^\d{4}$/;

function toTicketId(id) {
    const source = String(id || '').trim().toUpperCase();
    if (!source) return 'PS-0000';

    // Deterministic 4-digit code derived from the pink slip id.
    let hash = 0;
    for (let i = 0; i < source.length; i += 1) {
        hash = (hash * 31 + source.charCodeAt(i)) % 10000;
    }

    return `PS-${String(hash).padStart(4, '0')}`;
}

function mapPinkSlipResponse(item) {
    if (!item) return item;
    return {
        ...item,
        ticketId: toTicketId(item.id),
    };
}

function normalizeTicketInput(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    return raw.replace(/^PS-/i, '').trim();
}

// Validation schemas
const createPinkSlipSchema = z.object({
    reason: z.string().min(5, 'Reason must be at least 5 characters'),
    fromDate: z.string().transform((str) => new Date(str)),
    toDate: z.string().transform((str) => new Date(str)),
});

const updatePinkSlipSchema = z.object({
    status: z.enum(['APPROVED', 'REJECTED']),
    remarks: z.string().optional(),
});

// ── Students: Create a request ───────────────────────────────
router.post('/', authenticate, requireRole('STUDENT'), validate(createPinkSlipSchema), async (req, res, next) => {
    try {
        const { reason, fromDate, toDate } = req.body;

        const pinkSlip = await prisma.pinkSlip.create({
            data: {
                studentId: req.user.id,
                reason,
                fromDate,
                toDate,
                status: 'PENDING',
            },
        });

        res.status(201).json({
            success: true,
            data: mapPinkSlipResponse(pinkSlip),
        });
    } catch (err) {
        next(err);
    }
});

// ── Students: Get my requests ───────────────────────────────
router.get('/me', authenticate, requireRole('STUDENT'), async (req, res, next) => {
    try {
        const pinkSlips = await prisma.pinkSlip.findMany({
            where: { studentId: req.user.id },
            include: {
                approvedBy: {
                    select: { name: true },
                },
            },
            orderBy: { updatedAt: 'desc' },
        });

        res.json({
            success: true,
            data: pinkSlips.map(mapPinkSlipResponse),
        });
    } catch (err) {
        console.error(' [PinkSlip] Get My Requests Error:', err);
        next(err);
    }
});

// ── Admins: List all requests ────────────────────────────────
router.get('/', authenticate, requireRole('SUPER_ADMIN', 'HOD', 'WARDEN'), async (req, res, next) => {
    try {
        const { status, studentType, page = 1, limit = 50 } = req.query;
        const where = {};

        if (status) where.status = status;
        if (studentType) {
            if (String(studentType).toUpperCase() === 'HOSTELLER') {
                where.student = {
                    studentType: {
                        in: ['HOSTELLER_BOYS', 'HOSTELLER_GIRLS'],
                    },
                };
            } else {
                where.student = { studentType };
            }
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [pinkSlips, total] = await Promise.all([
            prisma.pinkSlip.findMany({
                where,
                include: {
                    student: {
                        select: {
                            fullName: true,
                            enrollmentNo: true,
                            department: true,
                            studentType: true,
                        },
                    },
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: parseInt(limit),
            }),
            prisma.pinkSlip.count({ where }),
        ]);

        res.json({
            success: true,
            data: {
                pinkSlips: pinkSlips.map(mapPinkSlipResponse),
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / parseInt(limit)),
            },
        });
    } catch (err) {
        console.error(' [PinkSlip] Admin List Error:', err);
        next(err);
    }
});

// ── Admins: Get request by ticket id ─────────────────────────
router.get('/ticket/:ticketId', authenticate, requireRole('SUPER_ADMIN', 'HOD', 'WARDEN', 'FACULTY', 'SECURITY_GUARD'), async (req, res, next) => {
    try {
        const normalized = normalizeTicketInput(req.params.ticketId);
        if (!normalized) {
            throw new AppError('Invalid ticket id format', 400, 'INVALID_TICKET_ID');
        }

        const includePayload = {
            student: {
                select: {
                    id: true,
                    fullName: true,
                    enrollmentNo: true,
                    department: true,
                    studentType: true,
                    phone: true,
                    email: true,
                    roomNo: true,
                },
            },
            approvedBy: {
                select: {
                    id: true,
                    name: true,
                    email: true,
                    role: true,
                },
            },
        };

        let pinkSlip = null;

        // Backward compatibility: still allow lookup by full object id ticket.
        if (OBJECT_ID_REGEX.test(normalized)) {
            pinkSlip = await prisma.pinkSlip.findUnique({
                where: { id: normalized.toLowerCase() },
                include: includePayload,
            });
        } else if (TICKET_CODE_REGEX.test(normalized)) {
            const ticketCode = `PS-${normalized}`;
            const candidates = await prisma.pinkSlip.findMany({
                include: includePayload,
                orderBy: { createdAt: 'desc' },
                take: 5000,
            });

            const matches = candidates.filter((item) => toTicketId(item.id) === ticketCode);
            if (matches.length > 1) {
                throw new AppError('Ticket id is ambiguous. Please ask student for latest request date/time.', 409, 'AMBIGUOUS_TICKET_ID');
            }
            pinkSlip = matches[0] || null;
        } else {
            throw new AppError('Invalid ticket id format', 400, 'INVALID_TICKET_ID');
        }

        if (!pinkSlip) {
            throw new AppError('Pink slip ticket not found', 404, 'PINK_SLIP_NOT_FOUND');
        }

        res.json({
            success: true,
            data: mapPinkSlipResponse(pinkSlip),
        });
    } catch (err) {
        next(err);
    }
});

// ── Admins: Approve or Reject ────────────────────────────────
router.patch('/:id', authenticate, requireRole('SUPER_ADMIN', 'HOD', 'WARDEN'), validate(updatePinkSlipSchema), async (req, res, next) => {
    try {
        const { id } = req.params;
        const { status, remarks } = req.body;

        const pinkSlip = await prisma.pinkSlip.update({
            where: { id },
            data: {
                status,
                remarks,
                approvedById: req.user.id,
            },
        });

        if (status === 'APPROVED') {
            const { sendPush } = require('../services/notification.service');
            sendPush({
                studentId: pinkSlip.studentId,
                title: 'Pink Slip Approved',
                body: 'Your Pink Slip was approved by the Warden.',
                data: { type: 'PINK_SLIP', action: 'APPROVED', slipId: pinkSlip.id }
            }).catch(console.error);
        }

        await logAction(req, {
            action: `PINK_SLIP_${status}`,
            entity: 'PinkSlip',
            entityId: id,
            newValue: { status, remarks },
        });

        res.json({
            success: true,
            data: mapPinkSlipResponse(pinkSlip),
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
