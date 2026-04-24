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
const { getGeofencingSettings } = require('../services/geofencing-settings.service');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const STUDENT_TYPES = new Set(['DAY_SCHOLAR', 'HOSTELLER_BOYS', 'HOSTELLER_GIRLS']);
const SCAN_IDEMPOTENCY_WINDOW_MS = 5 * 1000;
const SCAN_COOLDOWN_WINDOW_MS = 300 * 1000;
const activeScanIdempotencyLocks = new Map();

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

const dayWiseMealLimitSchema = z.object({
    dayNumber: z.coerce.number().int().min(1).max(90),
    coupons: z.coerce.number().int().min(0).max(500),
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
    dayWiseMealLimits: z.array(dayWiseMealLimitSchema).optional().default([]),
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
    dayWiseMealLimits: z.array(dayWiseMealLimitSchema).optional(),
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
    maxMealsPerParticipant: nullableIntField(1, 100).optional(),
    dayWiseMealLimits: z.array(dayWiseMealLimitSchema).optional(),
}).refine((payload) => payload.maxMealsPerParticipant !== undefined || payload.dayWiseMealLimits !== undefined, {
    message: 'At least one meal setting field is required',
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

function buildScanLockKey({ eventId, participantId, studentId, tokenType }) {
    return [String(eventId || ''), String(participantId || ''), String(studentId || ''), String(tokenType || '')].join(':');
}

function tryAcquireScanLock(lockKey) {
    const now = Date.now();
    const lock = activeScanIdempotencyLocks.get(lockKey);
    if (lock && lock.expiresAt > now) {
        return {
            acquired: false,
            retryAfterMs: Math.max(lock.expiresAt - now, 0),
        };
    }

    activeScanIdempotencyLocks.set(lockKey, { expiresAt: now + SCAN_IDEMPOTENCY_WINDOW_MS });
    return {
        acquired: true,
        retryAfterMs: 0,
    };
}

function releaseScanLock(lockKey) {
    activeScanIdempotencyLocks.delete(lockKey);
}

function computeCooldownRemainingSeconds(previousTime, currentTime = new Date()) {
    if (!(previousTime instanceof Date) || Number.isNaN(previousTime.getTime())) return 0;
    const nowMs = currentTime instanceof Date ? currentTime.getTime() : Date.now();
    const elapsedMs = Math.max(nowMs - previousTime.getTime(), 0);
    const remainingMs = Math.max(SCAN_COOLDOWN_WINDOW_MS - elapsedMs, 0);
    return Math.ceil(remainingMs / 1000);
}

function haversineDistanceMeters(from, to) {
    const earthRadius = 6371000;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(to.lat - from.lat);
    const dLng = toRad(to.lng - from.lng);

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
        + Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat))
        * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return earthRadius * c;
}

async function createEventStudentAuthLogSafe({
    studentId,
    studentEmail,
    enrollmentNo,
    action,
    status = 'FAILED',
    reason,
    metadata,
}) {
    try {
        await prisma.studentAuthLog.create({
            data: {
                studentId: studentId || null,
                studentEmail: studentEmail || null,
                enrollmentNo: enrollmentNo || null,
                action,
                status,
                reason: reason || null,
                metadata: metadata || null,
            },
        });
    } catch {
        // Ignore auth log failures to keep scan flow stable.
    }
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
    const normalizeHeaderKey = (value) => String(value || '')
        .replace(/\u00A0/g, ' ')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');

    const pick = (aliases) => {
        for (const alias of aliases) {
            if (Object.prototype.hasOwnProperty.call(row, alias)) {
                const directValue = row[alias];
                if (directValue != null && String(directValue).trim() !== '') return directValue;
            }
        }

        const normalizedMap = new Map();
        Object.entries(row || {}).forEach(([key, value]) => {
            normalizedMap.set(normalizeHeaderKey(key), value);
        });

        for (const alias of aliases) {
            const candidate = normalizedMap.get(normalizeHeaderKey(alias));
            if (candidate != null && String(candidate).trim() !== '') return candidate;
        }

        return '';
    };

    const fullName = String(
        pick(['fullName', 'name', 'studentName', 'student_name', 'Name', 'Name ']),
    ).trim();
    const email = String(pick(['email', 'loginId', 'login_id', 'Email', 'Email ID'])).trim().toLowerCase();
    const phone = String(pick(['phone', 'mobile', 'Mobile', 'Mobile No.', 'password'])).trim();
    const enrollmentNo = String(pick(['enrollmentNo', 'enrollment_no', 'enrollment', 'Enrollment No'])).trim();
    const department = String(pick(['department', 'Institue Name', 'Institute Name', 'Allocated Nodal Centre']) || 'EVENT').trim() || 'EVENT';
    const yearRaw = Number(pick(['year', 'Year']) || 1);
    const year = Number.isInteger(yearRaw) && yearRaw >= 1 && yearRaw <= 4 ? yearRaw : 1;
    const studentTypeRaw = String(pick(['studentType', 'student_type', 'Participant Type', 'Team Leader/ Team Member/Mentor', 'Team Name- Team Id-Participant Type']) || 'DAY_SCHOLAR').trim().toUpperCase();
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
    const sharedQrToken = await ensureMessSharedQrToken(event);

    await prisma.eventMessRule.deleteMany({ where: { eventId: event.id } });
    const created = [];

    for (const rule of rules) {
        const saved = await prisma.eventMessRule.create({
            data: {
                eventId: event.id,
                mealNumber: rule.mealNumber,
                mealLabel: rule.mealLabel,
                startTime: rule.startTime,
                endTime: rule.endTime,
                isActive: rule.isActive !== false,
                qrToken: sharedQrToken,
            },
        });

        created.push(saved);
    }

    return created;
}

async function ensureMessSharedQrToken(event) {
    const existingToken = String(event?.messSharedQrToken || '').trim();
    if (existingToken) {
        return existingToken;
    }

    const sharedQr = createEventMessQrToken({
        eventId: event.id,
        eventEndsAt: new Date(event.endTime),
    });

    await prisma.campusEvent.update({
        where: { id: event.id },
        data: {
            messSharedQrToken: sharedQr.token,
        },
    });

    return sharedQr.token;
}

function startAndEndOfDate(dateInput) {
    const start = new Date(dateInput || new Date());
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { start, end };
}

function nextDirectionalState(lastDirection, isFirstScan = false) {
    if (isFirstScan) return 'EXIT';
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

function normalizeDayWiseMealLimits(rawLimits) {
    if (!Array.isArray(rawLimits)) return [];

    const dayMap = new Map();
    for (const item of rawLimits) {
        const dayNumber = Number(item?.dayNumber);
        const coupons = Number(item?.coupons);
        if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 90) continue;
        if (!Number.isInteger(coupons) || coupons < 0) continue;
        dayMap.set(dayNumber, coupons);
    }

    return Array.from(dayMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([dayNumber, coupons]) => ({ dayNumber, coupons }));
}

function sumDayWiseCoupons(dayWiseMealLimits) {
    if (!Array.isArray(dayWiseMealLimits)) return 0;
    return dayWiseMealLimits.reduce((sum, item) => sum + Number(item?.coupons || 0), 0);
}

function splitGlobalAcrossDays(globalLimit, days) {
    const safeGlobal = Math.max(0, Math.trunc(Number(globalLimit) || 0));
    const safeDays = Math.max(1, Math.min(90, Math.trunc(Number(days) || 1)));

    const base = Math.floor(safeGlobal / safeDays);
    let remainder = safeGlobal % safeDays;

    return Array.from({ length: safeDays }, (_, index) => {
        const coupons = base + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder -= 1;
        return {
            dayNumber: index + 1,
            coupons,
        };
    });
}

function formatDayKeyInTimezone(date, timezone) {
    const target = date instanceof Date ? date : new Date(date);
    const tz = timezone || 'Asia/Kolkata';

    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });

    const parts = formatter.formatToParts(target);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;

    if (!year || !month || !day) {
        const fallback = new Date(target);
        return fallback.toISOString().slice(0, 10);
    }

    return `${year}-${month}-${day}`;
}

function buildLooseTimezoneWindow(dayKey) {
    const pivot = new Date(`${dayKey}T00:00:00.000Z`);
    const minOffsetMs = 18 * 60 * 60 * 1000;
    const maxOffsetMs = 42 * 60 * 60 * 1000;
    return {
        start: new Date(pivot.getTime() - minOffsetMs),
        end: new Date(pivot.getTime() + maxOffsetMs - 1),
    };
}

function computeEventDayNumber(eventStart, scanMoment, timezone) {
    const eventDayKey = formatDayKeyInTimezone(eventStart, timezone);
    const scanDayKey = formatDayKeyInTimezone(scanMoment, timezone);

    const eventDayUtc = new Date(`${eventDayKey}T00:00:00.000Z`);
    const scanDayUtc = new Date(`${scanDayKey}T00:00:00.000Z`);
    const diffDays = Math.floor((scanDayUtc.getTime() - eventDayUtc.getTime()) / (24 * 60 * 60 * 1000));

    return {
        dayNumber: Math.max(diffDays + 1, 1),
        dayKey: scanDayKey,
    };
}

function resolveEventDurationDays(eventStart, eventEnd, timezone) {
    const start = eventStart instanceof Date ? eventStart : new Date(eventStart);
    const end = eventEnd instanceof Date ? eventEnd : new Date(eventEnd);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return 1;
    }

    const computed = computeEventDayNumber(start, end, timezone);
    return Math.max(1, Math.min(90, Number(computed?.dayNumber || 1)));
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

// ── STUDENT ENDPOINTS ───────────────────────────────────────

// GET /upcoming — List upcoming active events
router.get('/upcoming', authenticate, requireRole('STUDENT'), async (req, res, next) => {
    try {
        const events = await prisma.campusEvent.findMany({
            where: {
                isActive: true,
                endTime: { gt: new Date() }
            },
            orderBy: { startTime: 'asc' },
            select: {
                id: true,
                name: true,
                description: true,
                eventDate: true,
                startTime: true,
                endTime: true,
                hostelGateLabel: true,
                _count: {
                    select: { participants: true }
                }
            }
        });

        const formatted = events.map(e => ({
            id: e.id,
            name: e.name,
            description: e.description,
            startDate: e.startTime,
            endDate: e.endTime,
            venue: e.hostelGateLabel || 'Campus',
            participantCount: e._count.participants,
            maxParticipants: null
        }));

        res.json({ success: true, data: { events: formatted } });
    } catch (err) {
        next(err);
    }
});

// GET /my-registrations — List events the student is registered for
router.get('/my-registrations', authenticate, requireRole('STUDENT'), async (req, res, next) => {
    try {
        const registrations = await prisma.eventParticipant.findMany({
            where: { 
                studentId: req.user.id,
                isActive: true
            },
            include: {
                event: {
                    select: {
                        id: true,
                        name: true,
                        description: true,
                        startTime: true,
                        endTime: true,
                        hostelGateLabel: true,
                    }
                }
            }
        });

        const formatted = registrations.map(reg => ({
            id: reg.id,
            eventId: reg.eventId,
            status: 'REGISTERED',
            registrationDate: reg.createdAt,
            event: {
                id: reg.event.id,
                name: reg.event.name,
                description: reg.event.description,
                startDate: reg.event.startTime,
                endDate: reg.event.endTime,
                venue: reg.event.hostelGateLabel || 'Campus'
            }
        }));

        res.json({ success: true, data: { registrations: formatted } });
    } catch (err) {
        next(err);
    }
});

// POST /:id/register — Self-register for an event
router.post('/:id/register', authenticate, requireRole('STUDENT'), async (req, res, next) => {
    try {
        const eventId = req.params.id;
        const studentId = req.user.id;

        const event = await prisma.campusEvent.findUnique({ where: { id: eventId } });
        if (!event || !event.isActive) {
            throw new AppError('Event not found or inactive', 404);
        }
        if (new Date(event.endTime) < new Date()) {
            throw new AppError('Cannot register for a past event', 400);
        }

        const student = await prisma.student.findUnique({ where: { id: studentId } });

        const existing = await prisma.eventParticipant.findFirst({
            where: { eventId, studentId }
        });

        if (existing) {
            if (!existing.isActive) {
                await prisma.eventParticipant.update({
                    where: { id: existing.id },
                    data: { isActive: true }
                });
                return res.json({ success: true, message: 'Registration restored' });
            }
            throw new AppError('Already registered', 400);
        }

        await prisma.eventParticipant.create({
            data: {
                eventId,
                studentId,
                enrollmentNo: student.enrollmentNo,
                fullName: student.fullName,
                email: student.email,
                phone: student.phone,
                loginId: student.email,
                isActive: true
            }
        });

        res.json({ success: true, message: 'Successfully registered' });
    } catch (err) {
        next(err);
    }
});

// POST /:id/cancel — Cancel registration
router.post('/:id/cancel', authenticate, requireRole('STUDENT'), async (req, res, next) => {
    try {
        const eventId = req.params.id;
        const studentId = req.user.id;

        const existing = await prisma.eventParticipant.findFirst({
            where: { eventId, studentId, isActive: true }
        });

        if (!existing) {
            throw new AppError('Registration not found', 404);
        }

        await prisma.eventParticipant.update({
            where: { id: existing.id },
            data: { isActive: false }
        });

        res.json({ success: true, message: 'Registration cancelled' });
    } catch (err) {
        next(err);
    }
});

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
        const timezone = payload.timezone || 'Asia/Kolkata';
        const eventDate = new Date(payload.eventDate);
        const endTime = new Date(payload.endTime);

        let normalizedDayWiseMealLimits = normalizeDayWiseMealLimits(payload.dayWiseMealLimits);
        const globalMealLimit = Number.isInteger(payload.maxMealsPerParticipant) && payload.maxMealsPerParticipant > 0
            ? payload.maxMealsPerParticipant
            : null;

        if (globalMealLimit != null && normalizedDayWiseMealLimits.length === 0) {
            const durationDays = resolveEventDurationDays(eventDate, endTime, timezone);
            normalizedDayWiseMealLimits = splitGlobalAcrossDays(globalMealLimit, durationDays);
        }

        if (globalMealLimit != null) {
            const dayWiseTotal = sumDayWiseCoupons(normalizedDayWiseMealLimits);
            if (dayWiseTotal > globalMealLimit) {
                throw new AppError(
                    `Day-wise coupons total (${dayWiseTotal}) cannot exceed global max meals (${globalMealLimit})`,
                    400,
                    'INVALID_DAY_WISE_MEAL_LIMITS',
                );
            }
        }

        const event = await prisma.campusEvent.create({
            data: {
                name: payload.name,
                description: payload.description || null,
                isStayHostel: Boolean(payload.isStayHostel),
                hostelGateLabel: payload.hostelGateLabel || null,
                timezone,
                reportRecipients: payload.reportRecipients || [],
                eventDate,
                startTime: new Date(payload.startTime),
                endTime,
                exitMode: payload.exitMode,
                customMax: payload.customMax ?? null,
                appliesTo: payload.appliesTo || ['ALL'],
                gateIds: payload.gateIds || [],
                maxMealsPerParticipant: payload.maxMealsPerParticipant ?? null,
                dayWiseMealLimits: normalizedDayWiseMealLimits,
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
            select: { id: true, maxMealsPerParticipant: true, dayWiseMealLimits: true },
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
                    dayWiseMealLimits: normalizeDayWiseMealLimits(event.dayWiseMealLimits),
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
        const existingEvent = await prisma.campusEvent.findUnique({
            where: { id: req.params.id },
            select: {
                id: true,
                name: true,
                eventDate: true,
                endTime: true,
                timezone: true,
                maxMealsPerParticipant: true,
                dayWiseMealLimits: true,
            },
        });
        if (!existingEvent) throw new AppError('Event not found', 404);

        let normalizedDayWiseMealLimits = req.body.dayWiseMealLimits !== undefined
            ? normalizeDayWiseMealLimits(req.body.dayWiseMealLimits)
            : normalizeDayWiseMealLimits(existingEvent.dayWiseMealLimits);

        const nextGlobalMealLimit = req.body.maxMealsPerParticipant !== undefined
            ? req.body.maxMealsPerParticipant
            : existingEvent.maxMealsPerParticipant;

        if (req.body.dayWiseMealLimits === undefined && req.body.maxMealsPerParticipant !== undefined && nextGlobalMealLimit != null) {
            const durationDays = resolveEventDurationDays(existingEvent.eventDate, existingEvent.endTime, existingEvent.timezone || 'Asia/Kolkata');
            normalizedDayWiseMealLimits = splitGlobalAcrossDays(nextGlobalMealLimit, durationDays);
        }

        if (nextGlobalMealLimit != null) {
            const dayWiseTotal = sumDayWiseCoupons(normalizedDayWiseMealLimits);
            if (dayWiseTotal > nextGlobalMealLimit) {
                throw new AppError(
                    `Day-wise coupons total (${dayWiseTotal}) cannot exceed global max meals (${nextGlobalMealLimit})`,
                    400,
                    'INVALID_DAY_WISE_MEAL_LIMITS',
                );
            }
        }

        const event = await prisma.campusEvent.update({
            where: { id: req.params.id },
            data: {
                ...(req.body.maxMealsPerParticipant !== undefined ? { maxMealsPerParticipant: req.body.maxMealsPerParticipant } : {}),
                ...(req.body.dayWiseMealLimits !== undefined ? { dayWiseMealLimits: normalizedDayWiseMealLimits } : {}),
            },
            select: {
                id: true,
                name: true,
                maxMealsPerParticipant: true,
                dayWiseMealLimits: true,
            },
        });

        res.json({ success: true, data: { event } });

        await logAction(req, {
            action: 'UPDATE_EVENT_MEAL_SETTINGS',
            entity: 'CampusEvent',
            entityId: event.id,
            oldValue: {
                name: existingEvent.name,
                maxMealsPerParticipant: existingEvent.maxMealsPerParticipant,
                dayWiseMealLimits: normalizeDayWiseMealLimits(existingEvent.dayWiseMealLimits),
            },
            newValue: {
                name: event.name,
                maxMealsPerParticipant: event.maxMealsPerParticipant,
                dayWiseMealLimits: normalizeDayWiseMealLimits(event.dayWiseMealLimits),
            },
        }).catch(() => { });
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

        // --- DYNAMIC STAY QR: always generate a new QR with 20s TTL ---
        const token = createEventStayQrToken({
            eventId: event.id,
            eventName: event.name,
            createdById: req.user.id,
            ttlSeconds: 20,
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

        // --- STATIC MESS QR PATCH ---
        if (!event.messQrToken) {
            const token = createEventMessQrToken({
                eventId: event.id,
                eventEndsAt: event.endTime,
            });
            await prisma.campusEvent.update({
                where: { id: event.id },
                data: { messQrToken: token.token },
            });
            event.messQrToken = token.token;
        }
        res.json({
            success: true,
            data: {
                eventId: event.id,
                eventName: event.name,
                sharedQrToken: event.messQrToken,
                sharedQrExpiresAt: null,
                rules: [],
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── PUT /:id/mess/rules — Replace mess meal rules ─────────────────────────
router.put('/:id/mess/rules', authenticate, requireRole('HOD', 'SUPER_ADMIN'), validate(upsertMessRulesSchema), async (req, res, next) => {
    try {
        const event = await prisma.campusEvent.findUnique({ where: { id: req.params.id } });
        if (!event) throw new AppError('Event not found', 404);

        const previousRules = await prisma.eventMessRule.findMany({
            where: { eventId: event.id },
            orderBy: { mealNumber: 'asc' },
            select: {
                mealNumber: true,
                mealLabel: true,
                startTime: true,
                endTime: true,
                isActive: true,
            },
        });

        const rules = await replaceMessRulesForEvent(event, req.body.rules || []);
        res.json({ success: true, data: { rules } });

        await logAction(req, {
            action: 'UPDATE_EVENT_MESS_RULES',
            entity: 'CampusEvent',
            entityId: event.id,
            oldValue: {
                rules: previousRules,
            },
            newValue: {
                rules: rules.map((rule) => ({
                    mealNumber: rule.mealNumber,
                    mealLabel: rule.mealLabel,
                    startTime: rule.startTime,
                    endTime: rule.endTime,
                    isActive: rule.isActive,
                })),
            },
        }).catch(() => { });
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
        const serverNow = new Date();
        const scannedAt = req.body.timestamp ? new Date(req.body.timestamp) : serverNow;
        const latitude = Number(req.body.latitude);
        const longitude = Number(req.body.longitude);
        const accuracy = Number(req.body.accuracy);
        const geofencingSettings = getGeofencingSettings();

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return res.status(400).json({
                success: false,
                data: {
                    result: 'GPS_REQUIRED',
                    badge: 'RED',
                    message: 'Location is required for event scanning.',
                },
            });
        }

        const eventScanDistance = haversineDistanceMeters(
            {
                lat: geofencingSettings.campusCenterLat,
                lng: geofencingSettings.campusCenterLng,
            },
            { lat: latitude, lng: longitude },
        );
        const effectiveEventRadius = Math.max(100, geofencingSettings.eventScanRadiusMetres);
        if (eventScanDistance > effectiveEventRadius) {
            await createEventStudentAuthLogSafe({
                studentId: req.user.id,
                studentEmail: req.user.email,
                action: 'EVENT_SCAN_GEOFENCE_FAIL',
                status: 'FAILED',
                reason: 'OUTSIDE_CAMPUS_GEOFENCE',
                metadata: {
                    distance: Math.round(eventScanDistance),
                    radius: effectiveEventRadius,
                    accuracy: Number.isFinite(accuracy) ? accuracy : null,
                },
            });

            return res.status(403).json({
                success: false,
                data: {
                    result: 'GPS_FAIL',
                    badge: 'RED',
                    message: `Outside campus geofence (${Math.round(eventScanDistance)}m / ${effectiveEventRadius}m).`,
                },
            });
        }

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

        let participant = await prisma.eventParticipant.findFirst({
            where: {
                eventId: event.id,
                studentId: req.user.id,
                isActive: true,
            },
            orderBy: { createdAt: 'asc' },
        });

        if (!participant) {
            participant = await prisma.eventParticipant.findFirst({
                where: {
                    eventId: event.id,
                    email: req.user.email,
                    isActive: true,
                },
                orderBy: { createdAt: 'asc' },
            });
        }

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

        const lockKey = buildScanLockKey({
            eventId: event.id,
            participantId: participant.id,
            studentId: req.user.id,
            tokenType: payload.tokenType,
        });
        const lockAttempt = tryAcquireScanLock(lockKey);
        if (!lockAttempt.acquired) {
            const retryAfterSeconds = Math.max(1, Math.ceil(lockAttempt.retryAfterMs / 1000));

            await createEventStudentAuthLogSafe({
                studentId: req.user.id,
                studentEmail: req.user.email,
                enrollmentNo: participant.enrollmentNo || null,
                action: 'EVENT_SCAN_IDEMPOTENT_BLOCK',
                status: 'FAILED',
                reason: payload.tokenType || 'UNKNOWN',
                metadata: {
                    eventId: event.id,
                    eventName: event.name,
                    retryAfterSeconds,
                },
            });

            return res.status(429).json({
                success: false,
                data: {
                    result: 'SCAN_IN_PROGRESS',
                    badge: 'AMBER',
                    message: `Please wait ${retryAfterSeconds}s before scanning again.`,
                    retryAfterSeconds,
                    eventName: event.name,
                },
            });
        }

        try {

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

                const stayCooldownRemainingSeconds = computeCooldownRemainingSeconds(previous?.scannedAt, serverNow);
                if (stayCooldownRemainingSeconds > 0) {
                    await createEventStudentAuthLogSafe({
                        studentId: req.user.id,
                        studentEmail: req.user.email,
                        enrollmentNo: participant.enrollmentNo || null,
                        action: 'EVENT_SCAN_COOLDOWN',
                        status: 'FAILED',
                        reason: 'STAY',
                        metadata: {
                            eventId: event.id,
                            eventName: event.name,
                            cooldownSecondsRemaining: stayCooldownRemainingSeconds,
                            cooldownWindowSeconds: SCAN_COOLDOWN_WINDOW_MS / 1000,
                        },
                    });

                    return res.status(429).json({
                        success: false,
                        data: {
                            result: 'SCAN_COOLDOWN_ACTIVE',
                            badge: 'AMBER',
                            message: `Cooldown active. Retry in ${stayCooldownRemainingSeconds}s.`,
                            cooldownSecondsRemaining: stayCooldownRemainingSeconds,
                            cooldownWindowSeconds: SCAN_COOLDOWN_WINDOW_MS / 1000,
                            eventName: event.name,
                        },
                    });
                }

                const isFirstScan = !previous;
                const direction = nextDirectionalState(previous?.direction || null, isFirstScan);
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

                const dayWiseMealLimits = normalizeDayWiseMealLimits(event.dayWiseMealLimits);
                const hasDayWiseConfig = dayWiseMealLimits.length > 0;
                const timezone = event.timezone || 'Asia/Kolkata';
                const { dayNumber, dayKey } = computeEventDayNumber(event.eventDate, scannedAt, timezone);
                const identityWhere = {
                    eventId: event.id,
                    OR: [
                        { participantId: participant.id },
                        { studentId: req.user.id },
                    ],
                };
                const dayWindow = buildLooseTimezoneWindow(dayKey);

                const [countedConsumedMeals, candidateDayScans, latestMealScan] = await Promise.all([
                    prisma.eventMealScan.count({ where: identityWhere }),
                    prisma.eventMealScan.findMany({
                        where: {
                            ...identityWhere,
                            scannedAt: {
                                gte: dayWindow.start,
                                lte: dayWindow.end,
                            },
                        },
                        select: {
                            scannedAt: true,
                        },
                    }),
                    prisma.eventMealScan.findFirst({
                        where: identityWhere,
                        orderBy: { scannedAt: 'desc' },
                        select: {
                            scannedAt: true,
                        },
                    }),
                ]);

                const mealCooldownRemainingSeconds = computeCooldownRemainingSeconds(latestMealScan?.scannedAt, serverNow);
                if (mealCooldownRemainingSeconds > 0) {
                    await createEventStudentAuthLogSafe({
                        studentId: req.user.id,
                        studentEmail: req.user.email,
                        enrollmentNo: participant.enrollmentNo || null,
                        action: 'EVENT_SCAN_COOLDOWN',
                        status: 'FAILED',
                        reason: 'MESS',
                        metadata: {
                            eventId: event.id,
                            eventName: event.name,
                            cooldownSecondsRemaining: mealCooldownRemainingSeconds,
                            cooldownWindowSeconds: SCAN_COOLDOWN_WINDOW_MS / 1000,
                            dayNumber,
                            dayLabel: dayKey,
                        },
                    });

                    return res.status(429).json({
                        success: false,
                        data: {
                            result: 'SCAN_COOLDOWN_ACTIVE',
                            badge: 'AMBER',
                            message: `Cooldown active. Retry in ${mealCooldownRemainingSeconds}s.`,
                            cooldownSecondsRemaining: mealCooldownRemainingSeconds,
                            cooldownWindowSeconds: SCAN_COOLDOWN_WINDOW_MS / 1000,
                            eventName: event.name,
                            dayNumber,
                            dayLabel: dayKey,
                        },
                    });
                }

                const explicitConsumedMeals = Number.isInteger(participant.mealsConsumed) && participant.mealsConsumed >= 0
                    ? participant.mealsConsumed
                    : null;
                // When admin manually edits consumed meals, that value should drive quota checks.
                // Fallback to counted scans only if explicit value is absent.
                const consumedMeals = explicitConsumedMeals ?? countedConsumedMeals;

                const scansToday = candidateDayScans.reduce((total, mealScan) => {
                    if (formatDayKeyInTimezone(mealScan.scannedAt, timezone) !== dayKey) return total;
                    return total + 1;
                }, 0);

                let mealNumber = consumedMeals + 1;
                let maxMealsAllowed = effectiveMaxMeals;
                let remainingMeals = effectiveMaxMeals == null ? null : Math.max(effectiveMaxMeals - consumedMeals, 0);
                let dayCouponLimit = null;

                if (hasDayWiseConfig) {
                    const selectedDay = dayWiseMealLimits.find((item) => item.dayNumber === dayNumber) || null;
                    dayCouponLimit = selectedDay ? selectedDay.coupons : 0;

                    const couponsBeforeDay = dayWiseMealLimits
                        .filter((item) => item.dayNumber < dayNumber)
                        .reduce((sum, item) => sum + item.coupons, 0);

                    if (scansToday >= dayCouponLimit) {
                        await createEventStudentAuthLogSafe({
                            studentId: req.user.id,
                            studentEmail: req.user.email,
                            enrollmentNo: participant.enrollmentNo || null,
                            action: 'EVENT_MEAL_OVER_ATTEMPT',
                            status: 'FAILED',
                            reason: 'DAY_LIMIT_REACHED',
                            metadata: {
                                eventId: event.id,
                                eventName: event.name,
                                dayNumber,
                                dayLabel: dayKey,
                                dayConsumed: scansToday,
                                dayCouponLimit,
                            },
                        });

                        return res.status(409).json({
                            success: false,
                            data: {
                                result: 'MEAL_DAY_LIMIT_REACHED',
                                badge: 'AMBER',
                                message: `Day ${dayNumber} coupons finished (${scansToday}/${dayCouponLimit}). Previous day coupons expire at midnight.`,
                                consumedMeals,
                                maxMealsAllowed: dayCouponLimit,
                                remainingMeals: 0,
                                eventName: event.name,
                                dayNumber,
                                dayLabel: dayKey,
                                dayConsumed: scansToday,
                                dayCouponLimit,
                            },
                        });
                    }

                    mealNumber = couponsBeforeDay + scansToday + 1;
                    maxMealsAllowed = dayCouponLimit;
                    remainingMeals = Math.max(dayCouponLimit - scansToday, 0);
                } else if (effectiveMaxMeals != null && consumedMeals >= effectiveMaxMeals) {
                    await createEventStudentAuthLogSafe({
                        studentId: req.user.id,
                        studentEmail: req.user.email,
                        enrollmentNo: participant.enrollmentNo || null,
                        action: 'EVENT_MEAL_OVER_ATTEMPT',
                        status: 'FAILED',
                        reason: 'GLOBAL_LIMIT_REACHED',
                        metadata: {
                            eventId: event.id,
                            eventName: event.name,
                            consumedMeals,
                            effectiveMaxMeals,
                        },
                    });

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
                            maxMealsAllowed,
                            remainingMeals,
                            eventName: event.name,
                            dayNumber,
                            dayLabel: dayKey,
                            dayConsumed: scansToday,
                            dayCouponLimit,
                        },
                    });
                }

                const nextConsumedMeals = consumedMeals + 1;
                const nextDayConsumed = scansToday + 1;
                const postConfirmRemaining = maxMealsAllowed == null
                    ? null
                    : hasDayWiseConfig
                        ? Math.max(maxMealsAllowed - nextDayConsumed, 0)
                        : Math.max(maxMealsAllowed - nextConsumedMeals, 0);
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
                                dayNumber,
                                dayLabel: dayKey,
                                dayCouponLimit,
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
                        maxMealsAllowed,
                        remainingMeals: postConfirmRemaining,
                        scanEventId: mealScan.id,
                        eventName: event.name,
                        dayNumber,
                        dayLabel: dayKey,
                        dayConsumed: nextDayConsumed,
                        dayCouponLimit,
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
        } finally {
            releaseScanLock(lockKey);
        }
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
        const existing = await prisma.campusEvent.findUnique({
            where: { id: req.params.id },
            select: {
                id: true,
                name: true,
                reportRecipients: true,
            },
        });
        if (!existing) throw new AppError('Event not found', 404);

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

        await logAction(req, {
            action: 'UPDATE_EVENT_REPORT_RECIPIENTS',
            entity: 'CampusEvent',
            entityId: event.id,
            oldValue: {
                name: existing.name,
                reportRecipients: existing.reportRecipients || [],
            },
            newValue: {
                name: existing.name,
                reportRecipients: event.reportRecipients || [],
            },
        }).catch(() => { });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /:id — Update event ───────────────────────────────
router.patch('/:id', authenticate, requireRole('HOD', 'SUPER_ADMIN'), validate(updateEventSchema), async (req, res, next) => {
    try {
        const existingEvent = await prisma.campusEvent.findUnique({
            where: { id: req.params.id },
            select: {
                id: true,
                name: true,
                description: true,
                isStayHostel: true,
                hostelGateLabel: true,
                reportRecipients: true,
                eventDate: true,
                startTime: true,
                endTime: true,
                timezone: true,
                exitMode: true,
                customMax: true,
                appliesTo: true,
                gateIds: true,
                maxMealsPerParticipant: true,
                dayWiseMealLimits: true,
            },
        });
        if (!existingEvent) throw new AppError('Event not found', 404);

        const data = { ...req.body };
        if (data.eventDate) data.eventDate = new Date(data.eventDate);
        if (data.startTime) data.startTime = new Date(data.startTime);
        if (data.endTime) data.endTime = new Date(data.endTime);

        let nextDayWiseMealLimits = data.dayWiseMealLimits !== undefined
            ? normalizeDayWiseMealLimits(data.dayWiseMealLimits)
            : normalizeDayWiseMealLimits(existingEvent.dayWiseMealLimits);

        const nextGlobalMealLimit = data.maxMealsPerParticipant !== undefined
            ? data.maxMealsPerParticipant
            : existingEvent.maxMealsPerParticipant;

        const effectiveEventDate = data.eventDate || existingEvent.eventDate;
        const effectiveEndTime = data.endTime || existingEvent.endTime;
        const effectiveTimezone = data.timezone || existingEvent.timezone || 'Asia/Kolkata';

        const shouldAutoRebuildDayWise = data.dayWiseMealLimits === undefined
            && nextGlobalMealLimit != null
            && (
                data.maxMealsPerParticipant !== undefined
                || data.eventDate !== undefined
                || data.endTime !== undefined
                || data.timezone !== undefined
            );

        if (shouldAutoRebuildDayWise) {
            const durationDays = resolveEventDurationDays(effectiveEventDate, effectiveEndTime, effectiveTimezone);
            nextDayWiseMealLimits = splitGlobalAcrossDays(nextGlobalMealLimit, durationDays);
        }

        if (nextGlobalMealLimit != null) {
            const dayWiseTotal = sumDayWiseCoupons(nextDayWiseMealLimits);
            if (dayWiseTotal > nextGlobalMealLimit) {
                throw new AppError(
                    `Day-wise coupons total (${dayWiseTotal}) cannot exceed global max meals (${nextGlobalMealLimit})`,
                    400,
                    'INVALID_DAY_WISE_MEAL_LIMITS',
                );
            }
        }

        if (data.dayWiseMealLimits !== undefined) {
            data.dayWiseMealLimits = nextDayWiseMealLimits;
        }

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

        const oldSnapshot = {
            name: existingEvent.name,
            description: existingEvent.description,
            isStayHostel: existingEvent.isStayHostel,
            hostelGateLabel: existingEvent.hostelGateLabel,
            reportRecipients: existingEvent.reportRecipients,
            eventDate: existingEvent.eventDate,
            startTime: existingEvent.startTime,
            endTime: existingEvent.endTime,
            timezone: existingEvent.timezone,
            exitMode: existingEvent.exitMode,
            customMax: existingEvent.customMax,
            appliesTo: existingEvent.appliesTo,
            gateIds: existingEvent.gateIds,
            maxMealsPerParticipant: existingEvent.maxMealsPerParticipant,
            dayWiseMealLimits: normalizeDayWiseMealLimits(existingEvent.dayWiseMealLimits),
        };

        const newSnapshot = {
            name: event.name,
            description: event.description,
            isStayHostel: event.isStayHostel,
            hostelGateLabel: event.hostelGateLabel,
            reportRecipients: event.reportRecipients,
            eventDate: event.eventDate,
            startTime: event.startTime,
            endTime: event.endTime,
            timezone: event.timezone,
            exitMode: event.exitMode,
            customMax: event.customMax,
            appliesTo: event.appliesTo,
            gateIds: event.gateIds,
            maxMealsPerParticipant: event.maxMealsPerParticipant,
            dayWiseMealLimits: normalizeDayWiseMealLimits(event.dayWiseMealLimits),
            ...(messRules ? { messRules } : {}),
        };

        await logAction(req, {
            action: 'UPDATE_CAMPUS_EVENT',
            entity: 'CampusEvent',
            entityId: event.id,
            oldValue: oldSnapshot,
            newValue: newSnapshot,
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

// ── DELETE /:id — Hard delete (cascade event-owned data) ─────
router.delete('/:id', authenticate, requireRole('HOD', 'SUPER_ADMIN'), async (req, res, next) => {
    try {
        const existing = await prisma.campusEvent.findUnique({
            where: { id: req.params.id },
            select: {
                id: true,
                name: true,
            },
        });
        if (!existing) throw new AppError('Event not found', 404);

        await prisma.$transaction([
            prisma.eventMealScan.deleteMany({ where: { eventId: existing.id } }),
            prisma.eventStayScan.deleteMany({ where: { eventId: existing.id } }),
            prisma.eventMessRule.deleteMany({ where: { eventId: existing.id } }),
            prisma.eventParticipant.deleteMany({ where: { eventId: existing.id } }),
            prisma.campusEvent.delete({ where: { id: existing.id } }),
        ]);

        res.json({
            success: true,
            data: {
                id: existing.id,
                message: 'Event deleted permanently',
            },
        });

        await logAction(req, {
            action: 'DELETE_CAMPUS_EVENT',
            entity: 'CampusEvent',
            entityId: existing.id,
            oldValue: {
                name: existing.name,
            },
        }).catch(() => { });
    } catch (err) {
        next(err);
    }
});

function scanRateGuard(req, res, next) {
    next();
}

module.exports = router;
