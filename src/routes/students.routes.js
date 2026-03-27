// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Student Routes
// CRUD, card management, health profile, scan history
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { z } = require('zod');
const multer = require('multer');
const { authenticate, requireRole, requireModule } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const prisma = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { encryptToken, generateCardUid, hashPassword } = require('../services/crypto.service');
const { logAction } = require('../services/audit.service');
const faceAiService = require('../services/faceAi.service');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Validation schemas
const createStudentSchema = z.object({
    enrollmentNo: z.string().min(1),
    fullName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
    department: z.string().min(1),
    year: z.number().int().min(1).max(4),
    section: z.string().optional(),
    studentType: z.enum(['DAY_SCHOLAR', 'HOSTELLER_BOYS', 'HOSTELLER_GIRLS']),
    photoUrl: z.string().url().optional(),
    bloodGroup: z.string().optional(),
    allergies: z.array(z.string()).optional(),
    conditions: z.array(z.string()).optional(),
    emergencyName: z.string().optional(),
    emergencyPhone: z.string().optional(),
    password: z.string().min(6).optional(),
});

const updateStudentSchema = createStudentSchema.partial();

// ── GET / — List students ───────────────────────────────────
router.get('/', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN'), async (req, res, next) => {
    try {
        const { dept, year, search, page = 1, limit = 100, type } = req.query;
        const where = {};
        if (dept) where.department = dept;
        if (year) where.year = parseInt(year);
        if (type) where.studentType = type;
        if (search) {
            where.OR = [
                { fullName: { contains: search, mode: 'insensitive' } },
                { enrollmentNo: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
            ];
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [students, total] = await Promise.all([
            prisma.student.findMany({
                where,
                include: { cards: { where: { status: 'ACTIVE' }, take: 1 } },
                orderBy: { fullName: 'asc' },
                skip,
                take: parseInt(limit),
            }),
            prisma.student.count({ where }),
        ]);

        res.json({
            success: true,
            data: {
                students,
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / parseInt(limit)),
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── POST / — Create student ────────────────────────────────
router.post('/', authenticate, requireRole('SUPER_ADMIN'), validate(createStudentSchema), async (req, res, next) => {
    try {
        const { password, ...studentData } = req.body;
        if (password) {
            studentData.passwordHash = await hashPassword(password);
        }
        const student = await prisma.student.create({ data: studentData });

        // Auto-create card
        const cardUid = generateCardUid();
        const qrToken = encryptToken({ enrollmentNo: student.enrollmentNo, cardId: cardUid });
        await prisma.card.create({
            data: { studentId: student.id, cardUid, qrToken, status: 'ACTIVE' },
        });

        await logAction(req, {
            action: 'CREATE_STUDENT',
            entity: 'Student',
            entityId: student.id,
            newValue: student
        }).catch(() => { });

        res.status(201).json({ success: true, data: { student } });
    } catch (err) {
        next(err);
    }
});

// ── POST /bulk-import — CSV upload ──────────────────────────
router.post('/bulk-import', authenticate, requireRole('SUPER_ADMIN'), upload.single('file'), async (req, res, next) => {
    try {
        if (!req.file) throw new AppError('CSV file required', 400);

        const csvData = req.file.buffer.toString('utf-8');
        const lines = csvData.split('\n').filter((l) => l.trim());
        if (lines.length < 2) throw new AppError('CSV must have header + data rows', 400);

        const headers = lines[0].split(',').map((h) => h.trim());
        const results = { created: 0, skipped: 0, errors: [] };

        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',').map((v) => v.trim());
            const row = {};
            headers.forEach((h, idx) => { row[h] = values[idx]; });

            try {
                const { password, ...rowData } = row;
                const studentData = {
                    enrollmentNo: rowData.enrollmentNo,
                    fullName: rowData.fullName,
                    email: rowData.email,
                    phone: rowData.phone || null,
                    department: rowData.department,
                    year: parseInt(rowData.year),
                    section: rowData.section || null,
                    studentType: rowData.studentType,
                };

                if (password || rowData.password) {
                    studentData.passwordHash = await hashPassword(password || rowData.password);
                }

                const student = await prisma.student.create({
                    data: studentData,
                });

                // Create card
                const cardUid = generateCardUid();
                const qrToken = encryptToken({ enrollmentNo: student.enrollmentNo, cardId: cardUid });
                await prisma.card.create({
                    data: { studentId: student.id, cardUid, qrToken, status: 'ACTIVE' },
                });

                results.created++;
            } catch (err) {
                if (err.code === 'P2002') {
                    results.skipped++;
                } else {
                    results.errors.push({ row: i, error: err.message });
                }
            }
        }

        res.json({ success: true, data: results });
    } catch (err) {
        next(err);
    }
});

// ── GET /:id — Student detail ───────────────────────────────
router.get('/:id', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'SECURITY_GUARD'), async (req, res, next) => {
    try {
        const student = await prisma.student.findUnique({
            where: { id: req.params.id },
            include: {
                cards: true,
            },
        });
        if (!student) throw new AppError('Student not found', 404);
        res.json({ success: true, data: { student } });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /:id — Update student ─────────────────────────────
router.patch('/:id', authenticate, requireRole('HOD', 'SUPER_ADMIN'), validate(updateStudentSchema), async (req, res, next) => {
    try {
        const student = await prisma.student.update({
            where: { id: req.params.id },
            data: req.body,
        });

        await logAction(req, {
            action: 'UPDATE_STUDENT',
            entity: 'Student',
            entityId: student.id,
            newValue: req.body
        }).catch(() => { });

        res.json({ success: true, data: { student } });
    } catch (err) {
        next(err);
    }
});

// ── DELETE /:id — Soft delete ───────────────────────────────
router.delete('/:id', authenticate, requireRole('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const student = await prisma.student.update({
            where: { id: req.params.id },
            data: { isActive: false },
        });

        await logAction(req, {
            action: 'DEACTIVATE_STUDENT',
            entity: 'Student',
            entityId: student.id
        }).catch(() => { });

        res.json({ success: true, data: { student, message: 'Student deactivated' } });
    } catch (err) {
        next(err);
    }
});

// ── POST /:id/card/deactivate ───────────────────────────────
router.post('/:id/card/deactivate', authenticate, requireRole('HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const { status = 'LOST' } = req.body;
        const card = await prisma.card.findFirst({
            where: { studentId: req.params.id, status: 'ACTIVE' },
        });
        if (!card) throw new AppError('No active card found', 404);

        const updated = await prisma.card.update({
            where: { id: card.id },
            data: { status, deactivatedAt: new Date(), deactivatedById: req.user.id },
        });

        await logAction(req, {
            action: 'CARD_DEACTIVATED',
            entity: 'Card',
            entityId: updated.id,
            newValue: { status, studentId: req.params.id }
        }).catch(() => { });

        res.json({ success: true, data: { card: updated } });
    } catch (err) {
        next(err);
    }
});

// ── POST /:id/card/replace ──────────────────────────────────
router.post('/:id/card/replace', authenticate, requireRole('HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const studentId = req.params.id;
        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) throw new AppError('Student not found', 404);

        // Deactivate old card
        await prisma.card.updateMany({
            where: { studentId, status: 'ACTIVE' },
            data: { status: 'REPLACED', deactivatedAt: new Date(), deactivatedById: req.user.id },
        });

        // Create new card
        const cardUid = generateCardUid();
        const qrToken = encryptToken({ enrollmentNo: student.enrollmentNo, cardId: cardUid });
        const newCard = await prisma.card.create({
            data: { studentId, cardUid, qrToken, status: 'ACTIVE' },
        });

        await logAction(req, {
            action: 'CARD_REPLACED',
            entity: 'Student',
            entityId: studentId,
            newValue: { newCardId: newCard.id }
        }).catch(() => { });

        res.json({ success: true, data: { card: newCard } });
    } catch (err) {
        next(err);
    }
});

// ── GET /:id/scan-history ───────────────────────────────────
router.get('/:id/scan-history', authenticate, requireRole('HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const { page = 1, limit = 50 } = req.query;
        const studentId = req.params.id;
        const [events, total] = await Promise.all([
            prisma.scanEvent.findMany({
                where: { studentId },
                orderBy: { scannedAt: 'desc' },
                skip: (parseInt(page) - 1) * parseInt(limit),
                take: parseInt(limit),
            }),
            prisma.scanEvent.count({ where: { studentId } }),
        ]);

        res.json({
            success: true,
            data: {
                events: events.map((e) => ({ ...e, id: e.id.toString() })),
                total,
                page: parseInt(page),
                pages: Math.ceil(total / parseInt(limit)),
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /:id/health — Medical profile ──────────────────────
router.get('/:id/health', authenticate, requireModule('HEALTH'), async (req, res, next) => {
    try {
        const student = await prisma.student.findUnique({
            where: { id: req.params.id },
            select: {
                id: true, fullName: true, enrollmentNo: true, bloodGroup: true,
                allergies: true, conditions: true, emergencyName: true, emergencyPhone: true,
            },
        });
        if (!student) throw new AppError('Student not found', 404);
        res.json({ success: true, data: { health: student } });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /:id/health — Update medical profile ─────────────
router.patch('/:id/health', authenticate, requireModule('HEALTH'), async (req, res, next) => {
    try {
        const { bloodGroup, allergies, conditions, emergencyName, emergencyPhone } = req.body;
        const student = await prisma.student.update({
            where: { id: req.params.id },
            data: { bloodGroup, allergies, conditions, emergencyName, emergencyPhone },
        });
        res.json({ success: true, data: { health: student } });
    } catch (err) {
        next(err);
    }
});

// ── POST /:id/face-register — Register face embeddings ────────────
const faceRegisterSchema = z.object({
    faceImages: z.array(z.string()).min(10, 'Minimum 10 face captures required'),
    timestamp: z.string().datetime().optional(),
});

router.post('/:id/face-register', authenticate, validate(faceRegisterSchema), async (req, res, next) => {
    try {
        const studentId = req.params.id;
        const { faceImages, timestamp } = req.body;

        // Verify student exists
        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) throw new AppError('Student not found', 404);

        // Check if face data already exists
        let faceData = await prisma.faceData.findUnique({ where: { studentId } });

        const captures = faceImages.slice(0, 10);

        let extraction;
        try {
            extraction = await faceAiService.extractBatchDescriptor(captures);
        } catch (error) {
            if (error.status === 422) {
                throw new AppError('No valid live face detected. Ensure face is clear, centered, and not spoofed.', 422);
            }
            throw new AppError('Face AI service unavailable. Start Python face service and try again.', 503);
        }

        if (extraction?.isLive === false) {
            throw new AppError('Anti-spoofing check failed during enrollment. Please retry with a real live face.', 422);
        }

        const allDescriptors = Array.isArray(extraction?.descriptors)
            ? extraction.descriptors.filter((descriptor) => Array.isArray(descriptor) && descriptor.length >= 128)
            : [];

        const liveIndexes = Array.isArray(extraction?.liveDescriptorIndexes)
            ? extraction.liveDescriptorIndexes
            : [];

        const liveDescriptors = liveIndexes
            .map((index) => allDescriptors[index])
            .filter(Boolean);

        const selectedDescriptors = (liveDescriptors.length > 0 ? liveDescriptors : allDescriptors).slice(0, 10);
        const embeddingDimension = selectedDescriptors[0]?.length || 0;

        if (embeddingDimension < 128 || selectedDescriptors.some((descriptor) => descriptor.length !== embeddingDimension)) {
            throw new AppError('Face descriptor extraction failed', 422);
        }

        const faceEmbeddings = selectedDescriptors.flat();

        const qualityScore = Number(extraction?.qualityScore || 0);

        if (faceData) {
            // Update existing face data
            faceData = await prisma.faceData.update({
                where: { studentId },
                data: {
                    faceImages: captures,
                    faceEmbeddings,
                    qualityScore,
                    isActive: true,
                    updatedAt: new Date(),
                },
            });
        } else {
            // Create new face data
            faceData = await prisma.faceData.create({
                data: {
                    studentId,
                    faceImages: captures,
                    faceEmbeddings,
                    qualityScore,
                    enrolledBy: req.user?.id,
                    enrolledAt: timestamp ? new Date(timestamp) : new Date(),
                    isActive: true,
                },
            });
        }

        res.json({
            success: true,
            data: {
                faceData: {
                    studentId: faceData.studentId,
                    enrolledAt: faceData.enrolledAt,
                    qualityScore: Math.round(faceData.qualityScore),
                    captureCount: faceData.faceImages?.length || 0,
                },
            },
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
