// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Events Routes
// Event creation/import, stay-hostel QR logs, mess rules + meal confirmations
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { z } = require('zod');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const prisma = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { logAction } = require('../services/audit.service');
const {
    createEventStayQrToken,
    createEventMessQrToken,
    verifyEventQrToken,
} = require('../services/eventQrToken.service');
const {
    buildEventDailyCsv,
    sendDailyEventReportForEvent,
} = require('../services/eventReports.service');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const STUDENT_TYPES = new Set(['DAY_SCHOLAR', 'HOSTELLER_BOYS', 'HOSTELLER_GIRLS']);

const nullableIntField = (min, max) => z.preprocess((value) => {
    if (value === null || value === undefined || value === '') return value;
    const numeric = Number(value);
    return Number.isNaN(numeric) ? value : numeric;
}, z.union([
    z.number().int().min(min).max(max),
    z.null(),
]));

const participantSchema = z.object({
    fullName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().min(4),
    enrollmentNo: z.string().optional().nullable(),
    department: z.string().optional().nullable(),
    year: z.coerce.number().int().min(1).max(4).optional().nullable(),
    studentType: z.string().optional().nullable(),
}).passthrough();

const messRuleSchema = z.object({
    mealNumber: z.coerce.number().int().min(1).max(20),
    mealLabel: z.string().min(1).max(100),
    startTime: z.string().min(4).max(12),
    endTime: z.string().min(4).max(12),
    isActive: z.boolean().optional().default(true),
});

const createEventSchema = z.object({
    name: z.string().min(1),
    description: z.string().optional().nullable(),
    eventDate: z.string().datetime().or(z.string()),
    startTime: z.string().datetime().or(z.string()),
    endTime: z.string().datetime().or(z.string()),
    isStayHostel: z.boolean().optional().default(false),
    hostelGateLabel: z.string().optional().nullable(),
    timezone: z.string().optional().default('Asia/Kolkata'),
    reportRecipients: z.array(z.string().email()).optional().default([]),
    exitMode: z.enum(['SINGLE', 'UNLIMITED', 'CUSTOM']).optional().default('SINGLE'),
    customMax: z.number().int().positive().optional().nullable(),
    appliesTo: z.array(z.string()).default(['ALL']),
    gateIds: z.array(z.string()).default([]),
    maxMealsPerParticipant: nullableIntField(1, 100).optional(),
    participants: z.array(participantSchema).optional().default([]),
    messRules: z.array(messRuleSchema).optional().default([]),
});

const updateEventSchema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional().nullable(),
    eventDate: z.string().datetime().or(z.string()).optional(),
    startTime: z.string().datetime().or(z.string()).optional(),
    endTime: z.string().datetime().or(z.string()).optional(),
    isStayHostel: z.boolean().optional(),
    hostelGateLabel: z.string().optional().nullable(),
    timezone: z.string().optional(),
    reportRecipients: z.array(z.string().email()).optional(),
    exitMode: z.enum(['SINGLE', 'UNLIMITED', 'CUSTOM']).optional(),
    customMax: z.number().int().positive().optional().nullable(),
    appliesTo: z.array(z.string()).optional(),
    gateIds: z.array(z.string()).optional(),
    maxMealsPerParticipant: nullableIntField(1, 100).optional(),
    messRules: z.array(messRuleSchema).optional(),
});

const importParticipantsSchema = z.object({
    participants: z.array(participantSchema),
});

const updateRecipientsSchema = z.object({
    emails: z.array(z.string().email()).default([]),
});

const upsertMessRulesSchema = z.object({
    rules: z.array(messRuleSchema),
});

const updateEventMealSettingsSchema = z.object({
    maxMealsPerParticipant: nullableIntField(1, 100),
});

const updateParticipantMealsSchema = z.object({
    maxMealsAllowed: nullableIntField(1, 100).optional(),
    mealsConsumed: nullableIntField(0, 200).optional(),
}).refine((payload) => payload.maxMealsAllowed !== undefined || payload.mealsConsumed !== undefined, {
    message: 'At least one meal field is required',
});

function isAuthorizedCronRequest(req) {
    const secret = String(process.env.CRON_SECRET || '').trim();
    if (!secret) {
        return false;
    }

    const auth = String(req.headers.authorization || '').trim();
    return auth === `Bearer ${secret}`;
}

const eventScanSchema = z.object({
    qr_token: z.string().optional(),
    qrToken: z.string().optional(),
    event_type: z.enum(['ENTRY', 'EXIT']).optional(),
    latitude: z.coerce.number().optional(),
    longitude: z.coerce.number().optional(),
    accuracy: z.coerce.number().optional(),
    confirm_meal: z.boolean().optional().default(false),
    timestamp: z.string().datetime().optional(),
}).refine((payload) => Boolean(payload.qr_token || payload.qrToken), {
    message: 'qr_token is required',
});

function normalizeParticipantRow(row) {
    const fullName = String(
        row.fullName || row.name || row.studentName || row.student_name || '',
    ).trim();
    const email = String(row.email || row.loginId || row.login_id || '').trim().toLowerCase();
    const phone = String(row.phone || row.mobile || row.password || '').trim();
    const enrollmentNo = String(row.enrollmentNo || row.enrollment_no || row.enrollment || '').trim();
    const department = String(row.department || 'EVENT').trim() || 'EVENT';
    const yearRaw = Number(row.year || 1);
    const year = Number.isInteger(yearRaw) && yearRaw >= 1 && yearRaw <= 4 ? yearRaw : 1;
    const studentTypeRaw = String(row.studentType || row.student_type || 'DAY_SCHOLAR').trim().toUpperCase();
    const studentType = STUDENT_TYPES.has(studentTypeRaw) ? studentTypeRaw : 'DAY_SCHOLAR';

    if (!fullName) {
        return { valid: false, reason: 'Missing fullName' };
    }
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
        return { valid: false, reason: 'Missing/invalid email' };
    }
    if (!phone || phone.length < 4) {
        return { valid: false, reason: 'Missing/invalid phone' };
    }

    return {
        valid: true,
        data: {
            fullName,
            email,
            phone,
            enrollmentNo: enrollmentNo || null,
            department,
            year,
            studentType,
            loginId: email,
        },
    };
}

async function createUniqueEnrollment(basePrefix) {
    const seed = String(basePrefix || 'EVT').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 8) || 'EVT';
    for (let i = 0; i < 8; i += 1) {
        const suffix = `${Date.now().toString().slice(-4)}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}${i}`;
        const candidate = `${seed}-${suffix}`;
        const existing = await prisma.student.findFirst({ where: { enrollmentNo: candidate }, select: { id: true } });
        if (!existing) return candidate;
    }
    return `${seed}-${Date.now()}`;
}

async function importParticipantsForEvent(event, participants) {
    const dedupeMap = new Map();
    for (const row of participants) {
        const probe = normalizeParticipantRow(row);
        if (probe.valid) {
            dedupeMap.set(probe.data.email, row);
        }
    }

    const rows = Array.from(dedupeMap.values());
    const summary = {
        total: participants.length,
        attempted: rows.length,
        imported: 0,
        failed: 0,
        errors: [],
    };

    for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const normalized = normalizeParticipantRow(row);
        if (!normalized.valid) {
            summary.failed += 1;
            summary.errors.push({ row: i + 1, reason: normalized.reason });
            continue;
        }

        const p = normalized.data;
        try {
            const passwordHash = await bcrypt.hash(String(p.phone), 10);

            let student = await prisma.student.findUnique({ where: { email: p.email } });
            if (student) {
                student = await prisma.student.update({
                    where: { id: student.id },
                    data: {
                        fullName: p.fullName,
                        phone: p.phone,
                        department: student.department || p.department,
                        year: Number.isInteger(student.year) ? student.year : p.year,
                        studentType: student.studentType || p.studentType,
                        passwordHash,
                        isActive: true,
                    },
                });
            } else {
                const generatedEnrollment = p.enrollmentNo || await createUniqueEnrollment(event.name);
                student = await prisma.student.create({
                    data: {
                        enrollmentNo: generatedEnrollment,
                        fullName: p.fullName,
                        email: p.email,
                        phone: p.phone,
                        department: p.department,
                        year: p.year,
                        studentType: p.studentType,
                        passwordHash,
                        isActive: true,
                    },
                });
            }

            const existingParticipant = await prisma.eventParticipant.findFirst({
                where: {
                    eventId: event.id,
                    email: p.email,
                },
            });

            if (existingParticipant) {
                await prisma.eventParticipant.update({
                    where: { id: existingParticipant.id },
                    data: {
                        studentId: student.id,
                        enrollmentNo: student.enrollmentNo || p.enrollmentNo,
                        fullName: p.fullName,
                        phone: p.phone,
                        loginId: p.loginId,
                        passwordHint: p.phone,
                        isActive: true,
                        credentialsIssuedAt: new Date(),
                    },
                });
            } else {
                await prisma.eventParticipant.create({
                    data: {
                        eventId: event.id,
                        studentId: student.id,
                        enrollmentNo: student.enrollmentNo || p.enrollmentNo,
                        fullName: p.fullName,
                        email: p.email,
                        phone: p.phone,
                        loginId: p.loginId,
                        passwordHint: p.phone,
                        mealsConsumed: 0,
                        isActive: true,
                        credentialsIssuedAt: new Date(),
                    },
                });
            }

            summary.imported += 1;
        } catch (err) {
            summary.failed += 1;
            summary.errors.push({ row: i + 1, reason: err.message });
        }
    }

    if (summary.imported > 0) {
        await prisma.campusEvent.update({
            where: { id: event.id },
            data: { importedCount: { increment: summary.imported } },
        }).catch(() => { });
    }

    return summary;
}

async function replaceMessRulesForEvent(event, rules) {
    await prisma.eventMessRule.deleteMany({ where: { eventId: event.id } });
    const created = [];

    const sharedQr = createEventMessQrToken({
        eventId: event.id,
        eventEndsAt: new Date(event.endTime),
    });

    for (const rule of rules) {
        const saved = await prisma.eventMessRule.create({
            data: {
                eventId: event.id,
                mealNumber: rule.mealNumber,
                mealLabel: rule.mealLabel,
                startTime: rule.startTime,
                endTime: rule.endTime,
                isActive: rule.isActive !== false,
                qrToken: sharedQr.token,
            },
        });

        created.push(saved);
    }

    return created;
}

function startAndEndOfDate(dateInput) {
    const start = new Date(dateInput || new Date());
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { start, end };
}

function nextDirectionalState(lastDirection) {
    if (lastDirection === 'ENTRY') return 'EXIT';
    return 'ENTRY';
}

function resolveParticipantConsumedMeals(participant) {
    const explicitCount = Number(participant?.mealsConsumed);
    if (Number.isInteger(explicitCount) && explicitCount >= 0) {
        return explicitCount;
    }

    const countedScans = Number(participant?._count?.mealScans || 0);
    if (Number.isInteger(countedScans) && countedScans >= 0) {
        return countedScans;
    }

    return 0;
}

function buildParticipantMealStats(participant, eventMaxMeals) {
    const consumed = resolveParticipantConsumedMeals(participant);
    const overrideMaxRaw = Number(participant?.maxMealsAllowed);
    const overrideMax = Number.isInteger(overrideMaxRaw) && overrideMaxRaw > 0 ? overrideMaxRaw : null;
    const globalMax = Number.isInteger(eventMaxMeals) && eventMaxMeals > 0 ? eventMaxMeals : null;
    const effectiveMaxMeals = overrideMax ?? globalMax;
    const remaining = effectiveMaxMeals == null ? null : Math.max(effectiveMaxMeals - consumed, 0);

    return {
        consumed,
        remaining,
        effectiveMaxMeals,
        canAvailMore: effectiveMaxMeals == null ? true : remaining > 0,
    };
}

function sanitizePhone(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : null;
}

function parseNameChunks(nameChunk) {
    const cleaned = String(nameChunk || '').trim().replace(/\s+/g, ' ');
    if (!cleaned) {
        return { fullName: '' };
    }

    const tokens = cleaned.split(' ');
    const titleIndex = tokens.findIndex((token) => /^(mr|mrs|ms|dr|shri|smt)\.?$/i.test(token));

    if (titleIndex > 0) {
        return {
            fullName: tokens.slice(0, titleIndex).join(' '),
        };
    }

    if (tokens.length > 4) {
        return {
            fullName: tokens.slice(0, 4).join(' '),
        };
    }

    return { fullName: cleaned };
}

function extractParticipantsFromPdfText(pdfText) {
    const lines = String(pdfText || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    const groupedRows = [];
    let current = '';

    for (const line of lines) {
        const startsLikeRow = /^\d+\s+/.test(line) || /@/.test(line);
        if (startsLikeRow && current) {
            groupedRows.push(current);
            current = line;
        } else if (startsLikeRow) {
            current = line;
        } else if (current) {
            current += ` ${line}`;
        }
    }
    if (current) groupedRows.push(current);

    if (!groupedRows.length) {
        groupedRows.push(...lines);
    }

    const parsed = [];
    for (const rawRow of groupedRows) {
        const row = rawRow.replace(/\s+/g, ' ').trim();

        const strictMatch = row.match(/^\d+\s+(\S+)\s+([A-Za-z0-9]{6,})\s+(.+?)\s+(\d{10})\s+(\d{10})\s+([^\s]+@[^\s]+)\b/i);
        if (strictMatch) {
            const [, allottedNo, enrollmentNo, nameChunkRaw, fatherMobile, phone, email] = strictMatch;
            const { fullName } = parseNameChunks(nameChunkRaw);
            const chosenPhone = sanitizePhone(phone) || sanitizePhone(fatherMobile);

            if (fullName && email && chosenPhone) {
                parsed.push({
                    fullName,
                    email: String(email).trim().toLowerCase(),
                    phone: chosenPhone,
                    enrollmentNo: String(enrollmentNo || allottedNo || '').trim() || null,
                });
                continue;
            }
        }

        const emailMatch = row.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
        const phoneMatches = row.match(/(?:\+91[-\s]?)?\d{10}\b/g) || [];
        const email = emailMatch ? emailMatch[1].toLowerCase() : '';
        const phone = sanitizePhone(phoneMatches[0]);

        if (!email || !phone) continue;

        const beforeEmail = row.slice(0, row.indexOf(email)).trim();
        const cleanedName = beforeEmail
            .replace(/^\d+\s+/, '')
            .replace(/\b\d{3,}\b/g, ' ')
            .replace(/\b[A-Z0-9]{6,}\b/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (!cleanedName) continue;

        const enrollmentMatch = row.match(/\b[A-Za-z]{0,3}\d{4,}[A-Za-z0-9]*\b/);

        parsed.push({
            fullName: cleanedName,
            email,
            phone,
            enrollmentNo: enrollmentMatch ? String(enrollmentMatch[0]).trim() : null,
        });
    }

    const deduped = [];
    const seen = new Set();
    for (const row of parsed) {
        const key = row.email;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(row);
    }

    if (!deduped.length) {
        throw new AppError('Unable to extract participant rows from PDF. Please verify format or use CSV/Excel.', 400, 'PDF_PARSE_FAILED');
    }

    return deduped;
}

// ── GET / — List all events ─────────────────────────────────
router.get('/', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN'), async (req, res, next) => {
    try {
        const events = await prisma.campusEvent.findMany({
            orderBy: { eventDate: 'desc' },
            include: { createdBy: { select: { name: true } } },
        });

        const enriched = await Promise.all(events.map(async (event) => {
            const [participantsCount, stayScansCount, mealScansCount] = await Promise.all([
                prisma.eventParticipant.count({ where: { eventId: event.id } }),
                prisma.eventStayScan.count({ where: { eventId: event.id } }),
                prisma.eventMealScan.count({ where: { eventId: event.id } }),
            ]);
            return {
                ...event,
                participantsCount,
                stayScansCount,
                mealScansCount,
            };
        }));

        res.json({ success: true, data: { events: enriched } });
    } catch (err) {
        next(err);
    }
});

// ── POST /participants/parse-pdf — Extract participant rows from PDF ──────
router.post('/participants/parse-pdf', authenticate, requireRole('HOD', 'SUPER_ADMIN'), upload.single('file'), async (req, res, next) => {
    try {
        if (!req.file) throw new AppError('PDF file is required', 400, 'PDF_REQUIRED');

        const extension = String(req.file.originalname || '').split('.').pop()?.toLowerCase();
        const mime = String(req.file.mimetype || '').toLowerCase();

        if (extension !== 'pdf' && !mime.includes('pdf')) {
            throw new AppError('Only PDF files are supported on this endpoint', 400, 'INVALID_FILE_TYPE');
        }

        let PDFParse;
        try {
            ({ PDFParse } = require('pdf-parse'));
        } catch (err) {
            throw new AppError('PDF import is temporarily unavailable. Please use CSV/Excel.', 503, 'PDF_IMPORT_UNAVAILABLE');
        }

        const parser = new PDFParse({ data: req.file.buffer });
        let participants = [];
        try {
            const pdf = await parser.getText();
            participants = extractParticipantsFromPdfText(pdf.text || '');
        } finally {
            await parser.destroy();
        }

        res.json({
            success: true,
            data: {
                participants,
                total: participants.length,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /:id — Event detail ─────────────────────────────────
router.get('/:id', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN'), async (req, res, next) => {
    try {
        const event = await prisma.campusEvent.findUnique({
            where: { id: req.params.id },
            include: {
                createdBy: { select: { id: true, name: true, email: true } },
            },
        });
        if (!event) throw new AppError('Event not found', 404);

        const [participantsCount, stayScansCount, mealScansCount, messRulesCount] = await Promise.all([
            prisma.eventParticipant.count({ where: { eventId: event.id } }),
            prisma.eventStayScan.count({ where: { eventId: event.id } }),
            prisma.eventMealScan.count({ where: { eventId: event.id } }),
            prisma.eventMessRule.count({ where: { eventId: event.id } }),
        ]);

        res.json({
            success: true,
            data: {
                event: {
                    ...event,
                    participantsCount,
                    stayScansCount,
                    mealScansCount,
                    messRulesCount,
                },
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── POST / — Create event (with optional CSV/Excel imported participants payload) ──
router.post('/', authenticate, requireRole('HOD', 'SUPER_ADMIN'), validate(createEventSchema), async (req, res, next) => {
    try {
        const payload = req.body;
        const event = await prisma.campusEvent.create({
            data: {
                name: payload.name,
                description: payload.description || null,
                isStayHostel: Boolean(payload.isStayHostel),
                hostelGateLabel: payload.hostelGateLabel || null,
                timezone: payload.timezone || 'Asia/Kolkata',
                reportRecipients: payload.reportRecipients || [],
                eventDate: new Date(payload.eventDate),
                startTime: new Date(payload.startTime),
                endTime: new Date(payload.endTime),
                exitMode: payload.exitMode,
                customMax: payload.customMax ?? null,
                appliesTo: payload.appliesTo || ['ALL'],
                gateIds: payload.gateIds || [],
                maxMealsPerParticipant: payload.maxMealsPerParticipant ?? null,
                createdById: req.user.id,
            },
        });

        if (Array.isArray(payload.messRules) && payload.messRules.length > 0) {
            await replaceMessRulesForEvent(event, payload.messRules);
        }

        let importSummary = null;
        if (Array.isArray(payload.participants) && payload.participants.length > 0) {
            importSummary = await importParticipantsForEvent(event, payload.participants);
        }

        res.status(201).json({
            success: true,
            data: {
                event,
                importSummary,
            },
        });

        await logAction(req, {
            action: 'CREATE_CAMPUS_EVENT',
            entity: 'CampusEvent',
            entityId: event.id,
            newValue: {
                ...payload,
                participantsImported: importSummary?.imported || 0,
            },
        }).catch(() => { });
    } catch (err) {
        next(err);
    }
});

// ── POST /:id/participants/import — Import additional participants ─────────
router.post('/:id/participants/import', authenticate, requireRole('HOD', 'SUPER_ADMIN'), validate(importParticipantsSchema), async (req, res, next) => {
    try {
        const event = await prisma.campusEvent.findUnique({ where: { id: req.params.id } });
        if (!event) throw new AppError('Event not found', 404);

        const summary = await importParticipantsForEvent(event, req.body.participants || []);

        res.json({
            success: true,
            data: { summary },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /:id/participants — Event participants + credentials table ─────────
router.get('/:id/participants', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN'), async (req, res, next) => {
    try {
        const event = await prisma.campusEvent.findUnique({
            where: { id: req.params.id },
            select: { id: true, maxMealsPerParticipant: true },
        });
        if (!event) throw new AppError('Event not found', 404);

        const page = Math.max(1, Number(req.query.page || 1));
        const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
        const search = String(req.query.search || '').trim();

        const where = {
            eventId: req.params.id,
        };

        if (search) {
            where.OR = [
                { fullName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
                { loginId: { contains: search, mode: 'insensitive' } },
                { enrollmentNo: { contains: search, mode: 'insensitive' } },
            ];
        }

        const [participants, total] = await Promise.all([
            prisma.eventParticipant.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                include: {
                    student: {
                        select: {
                            id: true,
                            fullName: true,
                            email: true,
                            enrollmentNo: true,
                            studentType: true,
                        },
                    },
                    _count: {
                        select: {
                            mealScans: true,
                        },
                    },
                },
            }),
            prisma.eventParticipant.count({ where }),
        ]);

        const withMealStats = participants.map((participant) => ({
            ...participant,
            mealStats: buildParticipantMealStats(participant, event.maxMealsPerParticipant),
        }));

        res.json({
            success: true,
            data: {
                participants: withMealStats,
                total,
                page,
                limit,
                pages: Math.ceil(total / limit),
                eventMealSettings: {
                    maxMealsPerParticipant: event.maxMealsPerParticipant,
                },
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /:id/meal-settings — Set global meals per participant ───────────
router.patch('/:id/meal-settings', authenticate, requireRole('HOD', 'SUPER_ADMIN'), validate(updateEventMealSettingsSchema), async (req, res, next) => {
    try {
        const event = await prisma.campusEvent.update({
            where: { id: req.params.id },
            data: {
                maxMealsPerParticipant: req.body.maxMealsPerParticipant,
            },
            select: {
                id: true,
                name: true,
                maxMealsPerParticipant: true,
            },
        });

        res.json({ success: true, data: { event } });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /:id/participants/:participantId/meals — Edit participant meal usage ──
router.patch('/:id/participants/:participantId/meals', authenticate, requireRole('HOD', 'SUPER_ADMIN'), validate(updateParticipantMealsSchema), async (req, res, next) => {
    try {
        const [event, participant] = await Promise.all([
            prisma.campusEvent.findUnique({
                where: { id: req.params.id },
                select: { id: true, maxMealsPerParticipant: true },
            }),
            prisma.eventParticipant.findFirst({
                where: {
                    id: req.params.participantId,
                    eventId: req.params.id,
                },
                include: {
                    _count: {
                        select: {
                            mealScans: true,
                        },
                    },
                },
            }),
        ]);

        if (!event) throw new AppError('Event not found', 404);
        if (!participant) throw new AppError('Participant not found for this event', 404);

        const currentConsumed = resolveParticipantConsumedMeals(participant);
        const currentOverrideMax = Number.isInteger(participant.maxMealsAllowed) ? participant.maxMealsAllowed : null;

        const nextMaxMeals = req.body.maxMealsAllowed !== undefined
            ? req.body.maxMealsAllowed
            : currentOverrideMax;
        const nextConsumed = req.body.mealsConsumed !== undefined
            ? req.body.mealsConsumed
            : currentConsumed;

        const effectiveMax = nextMaxMeals ?? event.maxMealsPerParticipant ?? null;
        if (nextConsumed != null && effectiveMax != null && nextConsumed > effectiveMax) {
            throw new AppError('Consumed meals cannot be greater than max allowed meals', 400, 'INVALID_MEAL_COUNT');
        }

        const updated = await prisma.eventParticipant.update({
            where: { id: participant.id },
            data: {
                ...(req.body.maxMealsAllowed !== undefined ? { maxMealsAllowed: req.body.maxMealsAllowed } : {}),
                ...(req.body.mealsConsumed !== undefined ? { mealsConsumed: req.body.mealsConsumed } : {}),
            },
            include: {
                _count: {
                    select: {
                        mealScans: true,
                    },
                },
            },
        });

        res.json({
            success: true,
            data: {
                participant: {
                    ...updated,
                    mealStats: buildParticipantMealStats(updated, event.maxMealsPerParticipant),
                },
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /:id/stay/qr — Dynamic QR for stay-hostel event ───────────────────
router.get('/:id/stay/qr', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN', 'SECURITY_GUARD'), async (req, res, next) => {
    try {
        const event = await prisma.campusEvent.findUnique({ where: { id: req.params.id } });
        if (!event) throw new AppError('Event not found', 404);
        if (!event.isStayHostel) {
            throw new AppError('Stay-hostel flow is disabled for this event', 400);
        }

        const token = createEventStayQrToken({
            eventId: event.id,
            eventName: event.name,
            createdById: req.user.id,
            ttlSeconds: Number(req.query.ttl || 90),
        });

        res.json({
            success: true,
            data: {
                eventId: event.id,
                eventName: event.name,
                qr_token: token.token,
                expires_at: token.expiresAt.toISOString(),
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /:id/mess/qr — Static mess QR tokens by meal rule ────────────────
router.get('/:id/mess/qr', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN', 'SECURITY_GUARD'), async (req, res, next) => {
    try {
        const event = await prisma.campusEvent.findUnique({ where: { id: req.params.id } });
        if (!event) throw new AppError('Event not found', 404);

        const rules = await prisma.eventMessRule.findMany({
            where: { eventId: event.id, isActive: true },
            orderBy: { mealNumber: 'asc' },
        });

        const sharedQr = createEventMessQrToken({
            eventId: event.id,
            eventEndsAt: new Date(event.endTime),
        });

        const hydrated = [];
        for (const rule of rules) {
            if (rule.qrToken !== sharedQr.token) {
                const updated = await prisma.eventMessRule.update({
                    where: { id: rule.id },
                    data: { qrToken: sharedQr.token },
                });
                hydrated.push(updated);
            } else {
                hydrated.push(rule);
            }
        }

        res.json({ success: true, data: { sharedQrToken: sharedQr.token, rules: hydrated } });
    } catch (err) {
        next(err);
    }
});

// ── PUT /:id/mess/rules — Replace mess meal rules ─────────────────────────
router.put('/:id/mess/rules', authenticate, requireRole('HOD', 'SUPER_ADMIN'), validate(upsertMessRulesSchema), async (req, res, next) => {
    try {
        const event = await prisma.campusEvent.findUnique({ where: { id: req.params.id } });
        if (!event) throw new AppError('Event not found', 404);

        const rules = await replaceMessRulesForEvent(event, req.body.rules || []);
        res.json({ success: true, data: { rules } });
    } catch (err) {
        next(err);
    }
});

// ── GET /:id/mess/rules ────────────────────────────────────────────────────
router.get('/:id/mess/rules', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN'), async (req, res, next) => {
    try {
        const rules = await prisma.eventMessRule.findMany({
            where: { eventId: req.params.id },
            orderBy: { mealNumber: 'asc' },
        });
        res.json({ success: true, data: { rules } });
    } catch (err) {
        next(err);
    }
});

// ── POST /scan — Student scan for stay/mess event QR ──────────────────────
router.post('/scan', authenticate, requireRole('STUDENT'), scanRateGuard, validate(eventScanSchema), async (req, res, next) => {
    try {
        const qrToken = String(req.body.qr_token || req.body.qrToken || '').trim();
        const confirmMeal = Boolean(req.body.confirm_meal);
        const scannedAt = req.body.timestamp ? new Date(req.body.timestamp) : new Date();
        const latitude = Number(req.body.latitude);
        const longitude = Number(req.body.longitude);
        const accuracy = Number(req.body.accuracy);

        const verification = verifyEventQrToken(qrToken);
        if (!verification.valid) {
            return res.status(400).json({
                success: false,
                data: {
                    result: 'INVALID_EVENT_QR',
                    badge: 'RED',
                    message: 'Invalid or expired event QR.',
                },
            });
        }

        const payload = verification.payload;
        const event = await prisma.campusEvent.findUnique({ where: { id: payload.eventId } });
        if (!event) {
            throw new AppError('Event not found', 404);
        }
        if (!event.isActive) {
            return res.status(400).json({
                success: false,
                data: {
                    result: 'EVENT_INACTIVE',
                    badge: 'RED',
                    message: 'This event is not active.',
                },
            });
        }

        const participant = await prisma.eventParticipant.findFirst({
            where: {
                eventId: event.id,
                OR: [
                    { studentId: req.user.id },
                    { email: req.user.email },
                ],
                isActive: true,
            },
        });

        if (!participant) {
            return res.status(403).json({
                success: false,
                data: {
                    result: 'NOT_REGISTERED_FOR_EVENT',
                    badge: 'RED',
                    message: 'You are not registered for this event. Contact event admin.',
                },
            });
        }

        if (payload.tokenType === 'STAY') {
            if (!event.isStayHostel) {
                return res.status(400).json({
                    success: false,
                    data: {
                        result: 'STAY_DISABLED',
                        badge: 'RED',
                        message: 'Stay-hostel scanning is disabled for this event.',
                    },
                });
            }

            const previous = await prisma.eventStayScan.findFirst({
                where: {
                    eventId: event.id,
                    OR: [
                        { participantId: participant.id },
                        { studentId: req.user.id },
                    ],
                },
                orderBy: { scannedAt: 'desc' },
            });

            const direction = nextDirectionalState(previous?.direction || null);
            const scan = await prisma.eventStayScan.create({
                data: {
                    eventId: event.id,
                    participantId: participant.id,
                    studentId: req.user.id,
                    direction,
                    scanMode: 'DYNAMIC_QR',
                    gateLabel: event.hostelGateLabel || 'Event Hostel Gate',
                    result: 'VERIFIED',
                    scannedAt,
                    metadata: {
                        latitude: Number.isFinite(latitude) ? latitude : null,
                        longitude: Number.isFinite(longitude) ? longitude : null,
                        accuracy: Number.isFinite(accuracy) ? accuracy : null,
                        actorEmail: req.user.email,
                    },
                },
            });

            return res.json({
                success: true,
                data: {
                    result: 'VERIFIED',
                    badge: 'GREEN',
                    message: `${event.name}: ${direction} logged successfully.`,
                    eventName: event.name,
                    eventType: direction,
                    scanEventId: scan.id,
                },
            });
        }

        if (payload.tokenType === 'MESS') {
            const participantMaxMeals = Number.isInteger(participant.maxMealsAllowed) && participant.maxMealsAllowed > 0
                ? participant.maxMealsAllowed
                : null;
            const eventMaxMeals = Number.isInteger(event.maxMealsPerParticipant) && event.maxMealsPerParticipant > 0
                ? event.maxMealsPerParticipant
                : null;
            const effectiveMaxMeals = participantMaxMeals ?? eventMaxMeals;

            let consumedMeals = Number.isInteger(participant.mealsConsumed) && participant.mealsConsumed >= 0
                ? participant.mealsConsumed
                : null;

            if (consumedMeals == null) {
                consumedMeals = await prisma.eventMealScan.count({
                    where: {
                        eventId: event.id,
                        OR: [
                            { participantId: participant.id },
                            { studentId: req.user.id },
                        ],
                    },
                });
            }

            if (effectiveMaxMeals != null && consumedMeals >= effectiveMaxMeals) {
                return res.status(409).json({
                    success: false,
                    data: {
                        result: 'MEAL_LIMIT_REACHED',
                        badge: 'AMBER',
                        message: `Meal quota reached (${consumedMeals}/${effectiveMaxMeals}). Contact event admin for update.`,
                        consumedMeals,
                        maxMealsAllowed: effectiveMaxMeals,
                        remainingMeals: 0,
                        eventName: event.name,
                    },
                });
            }

            const mealNumber = consumedMeals + 1;
            const mealLabel = `Meal ${mealNumber}`;

            if (!confirmMeal) {
                return res.status(409).json({
                    success: false,
                    data: {
                        result: 'MEAL_CONFIRMATION_REQUIRED',
                        badge: 'AMBER',
                        message: `Confirm meal #${mealNumber} (${mealLabel}) to continue.`,
                        mealNumber,
                        mealLabel,
                        consumedMeals,
                        maxMealsAllowed: effectiveMaxMeals,
                        remainingMeals: effectiveMaxMeals == null ? null : Math.max(effectiveMaxMeals - consumedMeals, 0),
                        eventName: event.name,
                    },
                });
            }

            const nextConsumedMeals = consumedMeals + 1;
            const [mealScan] = await prisma.$transaction([
                prisma.eventMealScan.create({
                    data: {
                        eventId: event.id,
                        participantId: participant.id,
                        studentId: req.user.id,
                        mealRuleId: null,
                        mealNumber,
                        mealLabel,
                        scannedAt,
                        metadata: {
                            latitude: Number.isFinite(latitude) ? latitude : null,
                            longitude: Number.isFinite(longitude) ? longitude : null,
                            accuracy: Number.isFinite(accuracy) ? accuracy : null,
                            actorEmail: req.user.email,
                        },
                    },
                }),
                prisma.eventParticipant.update({
                    where: { id: participant.id },
                    data: { mealsConsumed: nextConsumedMeals },
                }),
            ]);

            return res.json({
                success: true,
                data: {
                    result: 'MEAL_CONFIRMED',
                    badge: 'GREEN',
                    message: `Meal #${mealNumber} (${mealLabel}) confirmed.`,
                    mealNumber,
                    mealLabel,
                    consumedMeals: nextConsumedMeals,
                    maxMealsAllowed: effectiveMaxMeals,
                    remainingMeals: effectiveMaxMeals == null ? null : Math.max(effectiveMaxMeals - nextConsumedMeals, 0),
                    scanEventId: mealScan.id,
                    eventName: event.name,
                },
            });
        }

        return res.status(400).json({
            success: false,
            data: {
                result: 'UNSUPPORTED_EVENT_QR',
                badge: 'RED',
                message: 'Unsupported event QR token.',
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /:id/stay/logs ─────────────────────────────────────────────────────
router.get('/:id/stay/logs', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN'), async (req, res, next) => {
    try {
        const page = Math.max(1, Number(req.query.page || 1));
        const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
        const search = String(req.query.search || '').trim();
        const date = String(req.query.date || '').trim();

        const where = { eventId: req.params.id };
        if (date) {
            const { start, end } = startAndEndOfDate(date);
            where.scannedAt = { gte: start, lte: end };
        }

        if (search) {
            where.OR = [
                { participant: { is: { fullName: { contains: search, mode: 'insensitive' } } } },
                { participant: { is: { email: { contains: search, mode: 'insensitive' } } } },
                { participant: { is: { enrollmentNo: { contains: search, mode: 'insensitive' } } } },
                { student: { is: { fullName: { contains: search, mode: 'insensitive' } } } },
                { student: { is: { email: { contains: search, mode: 'insensitive' } } } },
                { student: { is: { enrollmentNo: { contains: search, mode: 'insensitive' } } } },
            ];
        }

        const [logs, total] = await Promise.all([
            prisma.eventStayScan.findMany({
                where,
                orderBy: { scannedAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                include: {
                    participant: {
                        select: {
                            fullName: true,
                            email: true,
                            enrollmentNo: true,
                        },
                    },
                    student: {
                        select: {
                            fullName: true,
                            email: true,
                            enrollmentNo: true,
                        },
                    },
                },
            }),
            prisma.eventStayScan.count({ where }),
        ]);

        res.json({
            success: true,
            data: {
                logs,
                total,
                page,
                limit,
                pages: Math.ceil(total / limit),
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /:id/stay/summary ─────────────────────────────────────────────────
router.get('/:id/stay/summary', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN'), async (req, res, next) => {
    try {
        const date = String(req.query.date || '').trim();
        const dateWindow = date ? startAndEndOfDate(date) : startAndEndOfDate(new Date());

        const baseWhere = {
            eventId: req.params.id,
            scannedAt: {
                gte: dateWindow.start,
                lte: dateWindow.end,
            },
        };

        const [entries, exits, participantsCount, mealsToday] = await Promise.all([
            prisma.eventStayScan.count({ where: { ...baseWhere, direction: 'ENTRY' } }),
            prisma.eventStayScan.count({ where: { ...baseWhere, direction: 'EXIT' } }),
            prisma.eventParticipant.count({ where: { eventId: req.params.id, isActive: true } }),
            prisma.eventMealScan.count({ where: { eventId: req.params.id, scannedAt: { gte: dateWindow.start, lte: dateWindow.end } } }),
        ]);

        const inside = Math.max(entries - exits, 0);
        const outside = Math.max(participantsCount - inside, 0);

        res.json({
            success: true,
            data: {
                date: dateWindow.start.toISOString().slice(0, 10),
                entries,
                exits,
                inside,
                outside,
                participantsCount,
                mealsToday,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /:id/mess/logs ─────────────────────────────────────────────────────
router.get('/:id/mess/logs', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN'), async (req, res, next) => {
    try {
        const page = Math.max(1, Number(req.query.page || 1));
        const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
        const date = String(req.query.date || '').trim();
        const mealNumber = req.query.mealNumber ? Number(req.query.mealNumber) : null;

        const where = { eventId: req.params.id };
        if (date) {
            const { start, end } = startAndEndOfDate(date);
            where.scannedAt = { gte: start, lte: end };
        }
        if (Number.isInteger(mealNumber) && mealNumber > 0) {
            where.mealNumber = mealNumber;
        }

        const [logs, total] = await Promise.all([
            prisma.eventMealScan.findMany({
                where,
                orderBy: { scannedAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
                include: {
                    participant: {
                        select: {
                            fullName: true,
                            email: true,
                            enrollmentNo: true,
                        },
                    },
                    student: {
                        select: {
                            fullName: true,
                            email: true,
                            enrollmentNo: true,
                        },
                    },
                },
            }),
            prisma.eventMealScan.count({ where }),
        ]);

        res.json({
            success: true,
            data: {
                logs,
                total,
                page,
                limit,
                pages: Math.ceil(total / limit),
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── GET /:id/reports/daily-csv ─────────────────────────────────────────────
router.get('/:id/reports/daily-csv', authenticate, requireRole('HOD', 'SUPER_ADMIN', 'FACULTY', 'WARDEN'), async (req, res, next) => {
    try {
        const kind = String(req.query.kind || 'combined');
        const date = req.query.date ? new Date(String(req.query.date)) : new Date();

        const report = await buildEventDailyCsv({
            eventId: req.params.id,
            date,
            kind,
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${report.fileName}"`);
        res.send(report.csv);
    } catch (err) {
        next(err);
    }
});

// ── POST /:id/reports/send-daily ───────────────────────────────────────────
router.post('/:id/reports/send-daily', authenticate, requireRole('HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const event = await prisma.campusEvent.findUnique({ where: { id: req.params.id } });
        if (!event) throw new AppError('Event not found', 404);

        const date = req.body?.date ? new Date(req.body.date) : new Date();
        const outcome = await sendDailyEventReportForEvent(event, date);

        res.json({ success: true, data: { outcome } });
    } catch (err) {
        next(err);
    }
});

// ── GET /reports/cron/send-daily — Vercel cron trigger for all active events ──
router.get('/reports/cron/send-daily', async (req, res, next) => {
    try {
        if (!isAuthorizedCronRequest(req)) {
            throw new AppError('Unauthorized cron trigger', 401, 'UNAUTHORIZED_CRON');
        }

        const date = req.query?.date ? new Date(String(req.query.date)) : new Date();
        const outcomes = await sendDailyEventReports(date);

        res.json({
            success: true,
            data: {
                total: outcomes.length,
                outcomes,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── POST /:id/report-recipients ────────────────────────────────────────────
router.post('/:id/report-recipients', authenticate, requireRole('HOD', 'SUPER_ADMIN'), validate(updateRecipientsSchema), async (req, res, next) => {
    try {
        const event = await prisma.campusEvent.update({
            where: { id: req.params.id },
            data: {
                reportRecipients: req.body.emails || [],
            },
        });

        res.json({
            success: true,
            data: {
                reportRecipients: event.reportRecipients || [],
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /:id — Update event ───────────────────────────────
router.patch('/:id', authenticate, requireRole('HOD', 'SUPER_ADMIN'), validate(updateEventSchema), async (req, res, next) => {
    try {
        const data = { ...req.body };
        if (data.eventDate) data.eventDate = new Date(data.eventDate);
        if (data.startTime) data.startTime = new Date(data.startTime);
        if (data.endTime) data.endTime = new Date(data.endTime);

        const messRules = Array.isArray(data.messRules) ? data.messRules : null;
        if (messRules) {
            delete data.messRules;
        }

        const event = await prisma.campusEvent.update({
            where: { id: req.params.id },
            data,
        });

        if (messRules) {
            await replaceMessRulesForEvent(event, messRules);
        }

        res.json({ success: true, data: { event } });

        await logAction(req, {
            action: 'UPDATE_CAMPUS_EVENT',
            entity: 'CampusEvent',
            entityId: event.id,
            newValue: req.body,
        }).catch(() => { });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /:id/toggle — Activate/deactivate event ──────────
router.patch('/:id/toggle', authenticate, requireRole('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const current = await prisma.campusEvent.findUnique({
            where: { id: req.params.id },
        });
        if (!current) throw new AppError('Event not found', 404);

        const event = await prisma.campusEvent.update({
            where: { id: req.params.id },
            data: { isActive: !current.isActive },
        });
        res.json({ success: true, data: { event } });

        await logAction(req, {
            action: 'TOGGLE_CAMPUS_EVENT',
            entity: 'CampusEvent',
            entityId: event.id,
            newValue: { isActive: event.isActive },
        }).catch(() => { });
    } catch (err) {
        next(err);
    }
});

// ── DELETE /:id — Soft delete ───────────────────────────────
router.delete('/:id', authenticate, requireRole('SUPER_ADMIN'), async (req, res, next) => {
    try {
        const event = await prisma.campusEvent.update({
            where: { id: req.params.id },
            data: { isActive: false },
        });
        res.json({ success: true, data: { event, message: 'Event deactivated' } });

        await logAction(req, {
            action: 'DEACTIVATE_CAMPUS_EVENT',
            entity: 'CampusEvent',
            entityId: event.id,
        }).catch(() => { });
    } catch (err) {
        next(err);
    }
});

function scanRateGuard(req, res, next) {
    next();
}

module.exports = router;
