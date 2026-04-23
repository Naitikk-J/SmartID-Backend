

// CRUD, card management, health profile, scan history

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

const HEADER_ALIASES = {
    enrollmentno: 'enrollmentNo',
    enrollment: 'enrollmentNo',
    enrollno: 'enrollmentNo',
    studentname: 'fullName',
    fullname: 'fullName',
    name: 'fullName',
    fathername: 'fatherName',
    studetnroom: 'roomNo',
    studentroom: 'roomNo',
    room: 'roomNo',
    roomno: 'roomNo',
    roomnumber: 'roomNo',
    alloted: 'allottedNo',
    allotment: 'allottedNo',
    allotted: 'allottedNo',
    fathermobile: 'fatherMobile',
    fatherphone: 'fatherMobile',
    mobile: 'phone',
    studentmobile: 'phone',
    phone: 'phone',
    studentemailid: 'email',
    emailid: 'email',
    email: 'email',
    category: 'category',
    permanentaddress: 'permanentAddress',
    address: 'permanentAddress',
    department: 'department',
    year: 'year',
    section: 'section',
    studenttype: 'studentType',
    residentialtype: 'studentType',
    password: 'password',
};

function normalizeHeaderName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function canonicalizeHeader(value) {
    const normalized = normalizeHeaderName(value);
    return HEADER_ALIASES[normalized] || String(value || '').trim();
}

function parseCsvLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const next = line[i + 1];

        if (char === '"') {
            if (inQuotes && next === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (char === ',' && !inQuotes) {
            values.push(current.trim());
            current = '';
            continue;
        }

        current += char;
    }

    values.push(current.trim());
    return values;
}

function normalizeStudentType(value) {
    const normalized = String(value || '').trim().toUpperCase().replace(/\s+/g, '_');
    if (normalized === 'DAY_SCHOLAR') return 'DAY_SCHOLAR';
    if (normalized === 'HOSTELLER_GIRLS' || normalized === 'HOSTEL_GIRLS') return 'HOSTELLER_GIRLS';
    if (normalized === 'HOSTELLER_BOYS' || normalized === 'HOSTEL_BOYS' || normalized === 'HOSTELLER') return 'HOSTELLER_BOYS';
    return 'HOSTELLER_BOYS';
}

function sanitizePhone(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : null;
}

function inferYear(value) {
    const parsed = parseInt(String(value || ''), 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 4) return parsed;
    return 1;
}

function buildStudentDataFromRow(row) {
    const enrollmentNo = String(row.enrollmentNo || '').trim();
    const fullName = String(row.fullName || '').trim();

    if (!enrollmentNo || !fullName) {
        throw new Error('Missing required fields: enrollmentNo/fullName');
    }

    const emailCandidate = String(row.email || '').trim().toLowerCase();
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailCandidate)
        ? emailCandidate
        : `${enrollmentNo.toLowerCase()}@students.local`;

    const phone = sanitizePhone(row.phone || row.studentMobile || row.mobile);
    const emergencyPhone = sanitizePhone(row.fatherMobile || row.emergencyPhone);
    const emergencyName = String(row.fatherName || row.emergencyName || '').trim() || null;

    const department = String(row.department || row.category || '').trim() || 'GENERAL';
    const section = String(row.section || row.roomNo || row.allottedNo || '').trim() || null;
    const roomNo = String(row.roomNo || row.allottedNo || '').trim() || null;
    const allottedNo = String(row.allottedNo || '').trim() || null;
    const category = String(row.category || '').trim() || null;
    const permanentAddress = String(row.permanentAddress || row.address || '').trim() || null;
    const studentType = normalizeStudentType(row.studentType || row.residentialType);
    const year = inferYear(row.year);

    const studentData = {
        enrollmentNo,
        fullName,
        fatherName: emergencyName,
        email,
        phone,
        fatherMobile: emergencyPhone,
        department,
        year,
        section,
        roomNo,
        allottedNo,
        category,
        permanentAddress,
        studentType,
        emergencyName,
        emergencyPhone,
    };

    const passwordSeed = phone || emergencyPhone;
    if (!passwordSeed) {
        throw new Error('Student mobile is required to set initial password');
    }
    return { studentData, passwordSeed };
}

function extractRowsFromCsv(csvData) {
    const lines = csvData
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    if (lines.length < 2) {
        throw new AppError('CSV must have header + data rows', 400);
    }

    const rawHeaders = parseCsvLine(lines[0]);
    const headers = rawHeaders.map(canonicalizeHeader);
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
        let values = parseCsvLine(lines[i]);

        // Address fields often include commas without quotes; merge overflow into last column.
        if (values.length > headers.length) {
            values = [...values.slice(0, headers.length - 1), values.slice(headers.length - 1).join(',')];
        }

        const row = {};
        headers.forEach((header, idx) => {
            row[header] = (values[idx] || '').trim();
        });
        rows.push(row);
    }

    return rows;
}

function parseNameChunks(nameChunk) {
    const cleaned = String(nameChunk || '').trim().replace(/\s+/g, ' ');
    if (!cleaned) {
        return { fullName: '', fatherName: '' };
    }

    const tokens = cleaned.split(' ');
    const titleIndex = tokens.findIndex((token) => /^(mr|mrs|ms|dr|shri|smt)\.?$/i.test(token));

    if (titleIndex > 0) {
        return {
            fullName: tokens.slice(0, titleIndex).join(' '),
            fatherName: tokens.slice(titleIndex).join(' '),
        };
    }

    if (tokens.length > 2) {
        return {
            fullName: tokens.slice(0, 2).join(' '),
            fatherName: tokens.slice(2).join(' '),
        };
    }

    return { fullName: cleaned, fatherName: '' };
}

function extractRowsFromPdfText(pdfText) {
    const lines = pdfText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    const rowStarts = [];
    let current = '';

    for (const line of lines) {
        if (/^\d+\s+\S+\s+[A-Za-z0-9]{6,}/.test(line)) {
            if (current) rowStarts.push(current);
            current = line;
        } else if (current) {
            current += ` ${line}`;
        }
    }
    if (current) rowStarts.push(current);

    const parsedRows = [];

    for (const rawRow of rowStarts) {
        const row = rawRow.replace(/\s+/g, ' ').trim();
        const match = row.match(/^(\d+)\s+(\S+)\s+([A-Za-z0-9]{6,})\s+(.+?)\s+(\d{10})\s+(\d{10})\s+([^\s]+@[^\s]+)\s+([A-Za-z]+)\s+(.+)$/i);
        if (!match) continue;

        const [, , allottedNo, enrollmentNo, nameChunkRaw, fatherMobile, phone, email, category, permanentAddress] = match;

        let roomNo = '';
        let nameChunk = nameChunkRaw;
        const roomMatch = nameChunkRaw.match(/(.+?)\s+(\d{3,6})$/);
        if (roomMatch) {
            nameChunk = roomMatch[1];
            roomNo = roomMatch[2];
        }

        const { fullName, fatherName } = parseNameChunks(nameChunk);

        parsedRows.push({
            enrollmentNo,
            fullName,
            fatherName,
            fatherMobile,
            phone,
            email,
            category,
            permanentAddress,
            roomNo: roomNo || allottedNo,
            allottedNo,
        });
    }

    if (!parsedRows.length) {
        throw new AppError('Unable to extract student rows from PDF. Please upload CSV with headers instead.', 400);
    }

    return parsedRows;
}

// Validation schemas
const createStudentSchema = z.object({
    enrollmentNo: z.string().min(1),
    fullName: z.string().min(1),
    fatherName: z.string().optional(),
    email: z.string().email(),
    phone: z.string().min(10, 'Student mobile is required for initial password'),
    fatherMobile: z.string().optional(),
    department: z.string().min(1),
    year: z.number().int().min(1).max(4),
    section: z.string().optional(),
    roomNo: z.string().optional(),
    allottedNo: z.string().optional(),
    category: z.string().optional(),
    permanentAddress: z.string().optional(),
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
        const { dept, year, search, page = 1, limit = 100, type, userType } = req.query;
        const where = {};
        if (dept) where.department = dept;
        if (year) where.year = parseInt(year);
        if (type) where.studentType = type;
        if (userType) where.userType = userType;
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
        const studentPhone = sanitizePhone(studentData.phone);
        const guardianPhone = sanitizePhone(studentData.fatherMobile || studentData.emergencyPhone);
        const initialPassword = studentPhone || guardianPhone;

        if (!initialPassword) {
            throw new AppError('Student mobile is required to set initial password', 400);
        }

        studentData.phone = studentPhone;
        studentData.fatherMobile = guardianPhone;
        studentData.emergencyPhone = guardianPhone;
        studentData.passwordHash = await hashPassword(initialPassword);

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
        if (!req.file) throw new AppError('CSV or PDF file required', 400);

        const extension = String(req.file.originalname || '').split('.').pop()?.toLowerCase();
        const mime = String(req.file.mimetype || '').toLowerCase();

        let importedRows = [];
        if (extension === 'pdf' || mime.includes('pdf')) {
            // Lazy-load PDF parser so students route can boot even if pdf parser has runtime incompatibilities.
            let PDFParse;
            try {
                ({ PDFParse } = require('pdf-parse'));
            } catch (err) {
                throw new AppError('PDF import is temporarily unavailable. Use CSV import for now.', 503, 'PDF_IMPORT_UNAVAILABLE');
            }

            const parser = new PDFParse({ data: req.file.buffer });
            try {
                const pdf = await parser.getText();
                importedRows = extractRowsFromPdfText(pdf.text || '');
            } finally {
                await parser.destroy();
            }
        } else {
            const csvData = req.file.buffer.toString('utf-8');
            importedRows = extractRowsFromCsv(csvData);
        }

        const results = { created: 0, skipped: 0, errors: [] };

        for (let i = 0; i < importedRows.length; i++) {
            const row = importedRows[i];

            try {
                const { studentData, passwordSeed } = buildStudentDataFromRow(row);
                studentData.passwordHash = await hashPassword(passwordSeed);

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
                    results.errors.push({ row: i + 1, error: err.message });
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

// ── GET /by-type — Segregated student listing for apps ──────
router.get('/by-type', authenticate, requireRole('SUPER_ADMIN', 'HOD', 'FACULTY', 'WARDEN', 'SECURITY_GUARD'), async (req, res, next) => {
    try {
        const { userType = 'COLLEGE_STUDENT', page = '1', limit = '50', search, department, year } = req.query;
        const where = {};
        
        if (userType === 'COLLEGE_STUDENT') {
            where.userType = 'COLLEGE_STUDENT';
        } else if (userType === 'EVENT_PARTICIPANT') {
            where.userType = 'EVENT_PARTICIPANT';
        } else if (userType === 'EXTERNAL_USER') {
            where.userType = 'EXTERNAL_USER';
        }
        
        if (department) where.department = department;
        if (year) where.year = parseInt(year, 10);
        if (search) {
            where.OR = [
                { fullName: { contains: search, mode: 'insensitive' } },
                { enrollmentNo: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
            ];
        }
        
        const [students, total] = await Promise.all([
            prisma.student.findMany({
                where,
                skip: (parseInt(page) - 1) * parseInt(limit),
                take: parseInt(limit),
                orderBy: { fullName: 'asc' },
                select: {
                    id: true, fullName: true, enrollmentNo: true, email: true,
                    phone: true, department: true, year: true, section: true,
                    studentType: true, userType: true, photoUrl: true, isActive: true,
                    roomNo: true, allottedNo: true,
                },
            }),
            prisma.student.count({ where }),
        ]);
        
        res.json({
            success: true,
            data: {
                students,
                total,
                page: parseInt(page),
                pages: Math.ceil(total / parseInt(limit)),
                userType: userType === 'ALL' ? 'ALL' : userType,
            },
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
