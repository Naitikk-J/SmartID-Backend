// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Library Routes
// Book issue, return, overdue list, book management
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { z } = require('zod');
const { authenticate, requireModule } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const libraryService = require('../services/library.service');
const { decryptToken } = require('../services/crypto.service');
const prisma = require('../config/database');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

const issueSchema = z.object({
    studentRawToken: z.string().min(1),
    bookQrCode: z.string().min(1),
});

const returnSchema = z.object({
    studentRawToken: z.string().min(1),
    bookQrCode: z.string().min(1),
});

const addBookSchema = z.object({
    isbn: z.string().optional().nullable(),
    title: z.string().min(1),
    author: z.string().min(1),
    qrCode: z.string().min(1),
    totalCopies: z.number().int().min(1).default(1),
    availableCopies: z.number().int().min(0).default(1),
});

// Helper: resolve student from raw token
async function resolveStudent(rawToken) {
    const card = await prisma.card.findUnique({
        where: { qrToken: rawToken },
        include: { student: true },
    });
    if (!card || card.status !== 'ACTIVE') {
        throw new AppError('Invalid or inactive card', 400, 'INVALID_CARD');
    }
    return card.student;
}

// ── POST /issue ─────────────────────────────────────────────
router.post('/issue', authenticate, requireModule('LIBRARY'), validate(issueSchema), async (req, res, next) => {
    try {
        const student = await resolveStudent(req.body.studentRawToken);
        const transaction = await libraryService.issueBook({
            studentId: student.id,
            bookQrCode: req.body.bookQrCode,
        });
        res.status(201).json({ success: true, data: { transaction } });
    } catch (err) {
        next(err);
    }
});

// ── POST /return ────────────────────────────────────────────
router.post('/return', authenticate, requireModule('LIBRARY'), validate(returnSchema), async (req, res, next) => {
    try {
        const student = await resolveStudent(req.body.studentRawToken);
        const transaction = await libraryService.returnBook({
            studentId: student.id,
            bookQrCode: req.body.bookQrCode,
        });
        res.json({ success: true, data: { transaction } });
    } catch (err) {
        next(err);
    }
});

// ── GET /overdue ────────────────────────────────────────────
router.get('/overdue', authenticate, requireModule('LIBRARY'), async (req, res, next) => {
    try {
        const overdue = await libraryService.getOverdueList();
        res.json({
            success: true,
            data: { overdue },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /student/:id ────────────────────────────────────────
router.get('/student/:id', authenticate, requireModule('LIBRARY'), async (req, res, next) => {
    try {
        const history = await libraryService.getStudentBorrowHistory(req.params.id);
        res.json({
            success: true,
            data: { transactions: history },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /books ──────────────────────────────────────────────
router.get('/books', authenticate, requireModule('LIBRARY'), async (req, res, next) => {
    try {
        const result = await libraryService.getBooks(req.query);
        res.json({ success: true, data: result });
    } catch (err) {
        next(err);
    }
});

// ── POST /books — Add new book ──────────────────────────────
router.post('/books', authenticate, requireModule('LIBRARY'), validate(addBookSchema), async (req, res, next) => {
    try {
        const book = await libraryService.addBook(req.body);
        res.status(201).json({ success: true, data: { book } });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
