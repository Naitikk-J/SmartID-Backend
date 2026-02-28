// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Wallet Routes
// Balance, top-up, deduction, transaction history
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { z } = require('zod');
const { authenticate, requireModule } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const walletService = require('../services/wallet.service');
const prisma = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { logAction } = require('../services/audit.service');

const router = express.Router();

const topupSchema = z.object({
    amount: z.number().positive('Amount must be positive'),
    note: z.string().optional(),
});

const deductSchema = z.object({
    rawToken: z.string().min(1),
    amount: z.number().positive('Amount must be positive'),
    note: z.string().optional(),
});

// ── GET /:studentId/balance ─────────────────────────────────
router.get('/:studentId/balance', authenticate, requireModule('CANTEEN'), async (req, res, next) => {
    try {
        const balance = await walletService.getBalance(req.params.studentId);
        res.json({ success: true, data: { balance } });
    } catch (err) {
        next(err);
    }
});

// ── POST /:studentId/topup ──────────────────────────────────
router.post('/:studentId/topup', authenticate, requireModule('CANTEEN'), validate(topupSchema), async (req, res, next) => {
    try {
        const result = await walletService.topUp({
            studentId: req.params.studentId,
            amount: req.body.amount,
            note: req.body.note,
            adminId: req.user.id,
        });
        await logAction(req, {
            action: 'WALLET_TOPUP',
            entity: 'Wallet',
            entityId: result.wallet.id,
            newValue: { amount: req.body.amount, note: req.body.note, studentId: req.params.studentId }
        }).catch(() => { });

        res.json({
            success: true,
            data: {
                balance: parseFloat(result.wallet.balance),
                transactionId: result.transaction.id,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── POST /deduct — Canteen scan deduction ───────────────────
router.post('/deduct', authenticate, requireModule('CANTEEN'), validate(deductSchema), async (req, res, next) => {
    try {
        // Resolve student from QR token
        const card = await prisma.card.findUnique({
            where: { qrToken: req.body.rawToken },
            include: { student: true },
        });
        if (!card || card.status !== 'ACTIVE') {
            return res.json({
                success: true,
                data: { result: 'FAKE', badge: 'RED', message: 'Invalid or inactive card' },
            });
        }

        const result = await walletService.deduct({
            studentId: card.student.id,
            amount: req.body.amount,
            note: req.body.note,
        });

        await logAction(req, {
            action: 'WALLET_DEDUCT',
            entity: 'Wallet',
            entityId: result.wallet.id,
            newValue: { amount: req.body.amount, note: req.body.note, studentId: card.student.id }
        }).catch(() => { });

        res.json({ success: true, data: result });
    } catch (err) {
        next(err);
    }
});

// ── GET /:studentId/history ─────────────────────────────────
router.get('/:studentId/history', authenticate, requireModule('CANTEEN'), async (req, res, next) => {
    try {
        const result = await walletService.getTransactionHistory(req.params.studentId, req.query);
        res.json({ success: true, data: result });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
