const nodemailer = require('nodemailer');
const ExcelJS = require('exceljs');
const prisma = require('../config/database');
const logger = require('../config/logger');

const SUSPICIOUS_MOVEMENT_THRESHOLD = 8;

function startOfLocalDay(date) {
    const d = new Date(date || new Date());
    d.setHours(0, 0, 0, 0);
    return d;
}

function endOfLocalDay(date) {
    const d = startOfLocalDay(date);
    d.setHours(23, 59, 59, 999);
    return d;
}

function sanitizeFileName(input) {
    return String(input || 'event')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        || 'event';
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
        return new Date(target).toISOString().slice(0, 10);
    }

    return `${year}-${month}-${day}`;
}

function formatTimestampInTimezone(date, timezone) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';

    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone || 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).formatToParts(date);

    const year = parts.find((part) => part.type === 'year')?.value || '0000';
    const month = parts.find((part) => part.type === 'month')?.value || '00';
    const day = parts.find((part) => part.type === 'day')?.value || '00';
    const hour = parts.find((part) => part.type === 'hour')?.value || '00';
    const minute = parts.find((part) => part.type === 'minute')?.value || '00';
    const second = parts.find((part) => part.type === 'second')?.value || '00';

    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
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

function computeEventDayNumber(eventStart, scanMoment, timezone) {
    const eventDayKey = formatDayKeyInTimezone(eventStart, timezone);
    const scanDayKey = formatDayKeyInTimezone(scanMoment, timezone);

    const eventDayUtc = new Date(`${eventDayKey}T00:00:00.000Z`);
    const scanDayUtc = new Date(`${scanDayKey}T00:00:00.000Z`);
    const diffDays = Math.floor((scanDayUtc.getTime() - eventDayUtc.getTime()) / (24 * 60 * 60 * 1000));

    return Math.max(diffDays + 1, 1);
}

function stringifyMetadata(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function resolveIdentityKey({ participantId, studentId, email, enrollmentNo, fallbackName }) {
    if (participantId) return `P:${participantId}`;
    if (studentId) return `S:${studentId}`;
    if (email) return `E:${String(email).trim().toLowerCase()}`;
    if (enrollmentNo) return `N:${String(enrollmentNo).trim().toUpperCase()}`;
    return `X:${String(fallbackName || 'UNKNOWN').trim().toUpperCase()}`;
}

function getProfileFromEventLog(log) {
    const participant = log?.participant || {};
    const participantStudent = participant?.student || {};
    const student = log?.student || {};

    const fullName = participant.fullName || student.fullName || '';
    const email = participant.email || student.email || '';
    const enrollmentNo = participant.enrollmentNo || student.enrollmentNo || '';
    const phone = participant.phone || student.phone || '';
    const studentType = student.studentType || participantStudent.studentType || '';

    return {
        participantId: participant.id || null,
        studentId: participant.studentId || student.id || null,
        fullName,
        email,
        enrollmentNo,
        phone,
        studentType,
    };
}

function getAuthStatusLabel(status) {
    return String(status || '').trim().toUpperCase() || 'UNKNOWN';
}

function getDirectionLabel(direction) {
    const normalized = String(direction || '').trim().toUpperCase();
    if (normalized === 'ENTRY') return 'ENTRY';
    if (normalized === 'EXIT') return 'EXIT';
    return normalized || '';
}

function buildParticipantActivityKeySet(stayLogs, mealLogs) {
    const set = new Set();

    const addProfileKeys = (profile) => {
        if (!profile) return;
        const key = resolveIdentityKey({
            participantId: profile.participantId,
            studentId: profile.studentId,
            email: profile.email,
            enrollmentNo: profile.enrollmentNo,
            fallbackName: profile.fullName,
        });
        set.add(key);
    };

    for (const log of [...stayLogs, ...mealLogs]) {
        const profile = getProfileFromEventLog(log);
        addProfileKeys(profile);
    }

    return set;
}

function buildAbsentRows(participants, activityKeySet) {
    const rows = [];

    for (const participant of participants) {
        if (participant.isActive === false) continue;

        const key = resolveIdentityKey({
            participantId: participant.id,
            studentId: participant.studentId || participant.student?.id || null,
            email: participant.email || participant.student?.email || null,
            enrollmentNo: participant.enrollmentNo || participant.student?.enrollmentNo || null,
            fallbackName: participant.fullName || participant.student?.fullName,
        });

        if (activityKeySet.has(key)) continue;

        rows.push({
            name: participant.fullName || participant.student?.fullName || '',
            enrollmentNo: participant.enrollmentNo || participant.student?.enrollmentNo || '',
            email: participant.email || participant.student?.email || '',
            phone: participant.phone || participant.student?.phone || '',
            studentType: participant.student?.studentType || '',
            hasAnyScanToday: 'NO',
            notes: 'No event stay/meal scan found for report day',
        });
    }

    return rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function buildAnomalyRows({ authLogs, participantRows, eventId, timezone }) {
    const anomalies = [];

    for (const log of authLogs) {
        const metadata = log.metadata && typeof log.metadata === 'object' ? log.metadata : {};
        const isEventSpecific = String(metadata.eventId || '') === String(eventId);
        const name = log.student?.fullName || '';
        const enrollmentNo = log.enrollmentNo || log.student?.enrollmentNo || '';
        const email = log.studentEmail || log.student?.email || '';
        const timestamp = formatTimestampInTimezone(log.createdAt, timezone);

        if (String(log.action || '').toUpperCase() === 'EVENT_MEAL_OVER_ATTEMPT' && isEventSpecific) {
            anomalies.push({
                category: 'MEAL_OVER_ATTEMPT',
                severity: 'HIGH',
                timestamp,
                name,
                enrollmentNo,
                email,
                details: stringifyMetadata(metadata),
            });
        }

        if (getAuthStatusLabel(log.status) !== 'SUCCESS') {
            anomalies.push({
                category: 'AUTH_FAILURE',
                severity: 'MEDIUM',
                timestamp,
                name,
                enrollmentNo,
                email,
                details: `action=${log.action || ''}; reason=${log.reason || ''}`,
            });
        }
    }

    for (const row of participantRows) {
        if ((row.eventMovements || 0) < SUSPICIOUS_MOVEMENT_THRESHOLD) continue;
        anomalies.push({
            category: 'FREQUENT_ENTRY_EXIT',
            severity: 'MEDIUM',
            timestamp: '',
            name: row.name,
            enrollmentNo: row.enrollmentNo,
            email: row.email,
            details: `eventMovements=${row.eventMovements}; entries=${row.eventEntries}; exits=${row.eventExits}`,
        });
    }

    return anomalies;
}

function csvEscape(value) {
    const raw = value == null ? '' : String(value);
    if (/[",\n]/.test(raw)) {
        return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
}

function buildCsv(headers, rows) {
    const out = [headers.join(',')];
    for (const row of rows) {
        out.push(headers.map((header) => csvEscape(row[header])).join(','));
    }
    return out.join('\n');
}

async function fetchDailyData(eventId, date) {
    const event = await prisma.campusEvent.findUnique({
        where: { id: eventId },
        select: {
            id: true,
            name: true,
            description: true,
            timezone: true,
            eventDate: true,
            startTime: true,
            endTime: true,
            reportRecipients: true,
            isStayHostel: true,
            hostelGateLabel: true,
            maxMealsPerParticipant: true,
            dayWiseMealLimits: true,
        },
    });

    if (!event) {
        return {
            event: null,
            dayKey: null,
            timezone: 'Asia/Kolkata',
            participants: [],
            stayLogs: [],
            mealLogs: [],
            authLogs: [],
            hostelExitLogs: [],
            start: startOfLocalDay(date),
            end: endOfLocalDay(date),
        };
    }

    const timezone = event.timezone || 'Asia/Kolkata';
    const dayKey = formatDayKeyInTimezone(date, timezone);
    const looseWindow = buildLooseTimezoneWindow(dayKey);
    const isInTargetDay = (time) => formatDayKeyInTimezone(time, timezone) === dayKey;

    const [participants, stayLogsRaw, mealLogsRaw] = await Promise.all([
        prisma.eventParticipant.findMany({
            where: { eventId },
            orderBy: { createdAt: 'asc' },
            select: {
                id: true,
                studentId: true,
                fullName: true,
                email: true,
                phone: true,
                enrollmentNo: true,
                maxMealsAllowed: true,
                mealsConsumed: true,
                isActive: true,
                student: {
                    select: {
                        id: true,
                        fullName: true,
                        email: true,
                        enrollmentNo: true,
                        phone: true,
                        studentType: true,
                    },
                },
            },
        }),
        prisma.eventStayScan.findMany({
            where: {
                eventId,
                scannedAt: { gte: looseWindow.start, lte: looseWindow.end },
            },
            orderBy: { scannedAt: 'asc' },
            include: {
                participant: {
                    select: {
                        id: true,
                        studentId: true,
                        fullName: true,
                        email: true,
                        phone: true,
                        enrollmentNo: true,
                        student: {
                            select: {
                                id: true,
                                studentType: true,
                            },
                        },
                    },
                },
                student: {
                    select: {
                        id: true,
                        fullName: true,
                        email: true,
                        phone: true,
                        enrollmentNo: true,
                        studentType: true,
                    },
                },
            },
        }),
        prisma.eventMealScan.findMany({
            where: {
                eventId,
                scannedAt: { gte: looseWindow.start, lte: looseWindow.end },
            },
            orderBy: { scannedAt: 'asc' },
            include: {
                participant: {
                    select: {
                        id: true,
                        studentId: true,
                        fullName: true,
                        email: true,
                        phone: true,
                        enrollmentNo: true,
                        student: {
                            select: {
                                id: true,
                                studentType: true,
                            },
                        },
                    },
                },
                student: {
                    select: {
                        id: true,
                        fullName: true,
                        email: true,
                        phone: true,
                        enrollmentNo: true,
                        studentType: true,
                    },
                },
            },
        }),
    ]);

    const stayLogs = stayLogsRaw.filter((log) => isInTargetDay(log.scannedAt));
    const mealLogs = mealLogsRaw.filter((log) => isInTargetDay(log.scannedAt));

    const studentIds = new Set();
    const emails = new Set();
    const enrollmentNos = new Set();

    const collectIdentity = (profile) => {
        if (!profile) return;
        if (profile.studentId) studentIds.add(String(profile.studentId));
        if (profile.email) emails.add(String(profile.email).trim().toLowerCase());
        if (profile.enrollmentNo) enrollmentNos.add(String(profile.enrollmentNo).trim().toUpperCase());
    };

    for (const participant of participants) {
        collectIdentity({
            studentId: participant.studentId || participant.student?.id || null,
            email: participant.email || participant.student?.email || null,
            enrollmentNo: participant.enrollmentNo || participant.student?.enrollmentNo || null,
        });
    }

    for (const log of [...stayLogs, ...mealLogs]) {
        collectIdentity(getProfileFromEventLog(log));
    }

    const authOr = [];
    if (studentIds.size > 0) authOr.push({ studentId: { in: Array.from(studentIds) } });
    if (emails.size > 0) authOr.push({ studentEmail: { in: Array.from(emails) } });
    if (enrollmentNos.size > 0) authOr.push({ enrollmentNo: { in: Array.from(enrollmentNos) } });

    const [authLogsRaw, hostelExitLogsRaw] = await Promise.all([
        authOr.length > 0
            ? prisma.studentAuthLog.findMany({
                where: {
                    createdAt: { gte: looseWindow.start, lte: looseWindow.end },
                    OR: authOr,
                },
                orderBy: { createdAt: 'asc' },
                include: {
                    student: {
                        select: {
                            id: true,
                            fullName: true,
                            email: true,
                            enrollmentNo: true,
                            phone: true,
                            studentType: true,
                        },
                    },
                },
            })
            : Promise.resolve([]),
        studentIds.size > 0
            ? prisma.exitEvent.findMany({
                where: {
                    studentId: { in: Array.from(studentIds) },
                    eventTime: { gte: looseWindow.start, lte: looseWindow.end },
                },
                orderBy: { eventTime: 'asc' },
                include: {
                    student: {
                        select: {
                            id: true,
                            fullName: true,
                            email: true,
                            enrollmentNo: true,
                            phone: true,
                            studentType: true,
                        },
                    },
                    gate: {
                        select: {
                            name: true,
                            location: true,
                        },
                    },
                },
            })
            : Promise.resolve([]),
    ]);

    const authLogs = authLogsRaw.filter((log) => isInTargetDay(log.createdAt));
    const hostelExitLogs = hostelExitLogsRaw.filter((log) => isInTargetDay(log.eventTime));

    const start = new Date(`${dayKey}T00:00:00.000Z`);
    const end = new Date(`${dayKey}T23:59:59.999Z`);

    return {
        event,
        dayKey,
        timezone,
        participants,
        stayLogs,
        mealLogs,
        authLogs,
        hostelExitLogs,
        start,
        end,
    };
}

function buildParticipantReportRows({
    participants,
    stayLogs,
    mealLogs,
    authLogs,
    hostelExitLogs,
    event,
    timezone,
    dayKey,
}) {
    const aliasToCanonical = new Map();
    const participantMap = new Map();

    const addAliases = (canonicalKey, { participantId, studentId, email, enrollmentNo }) => {
        if (participantId) aliasToCanonical.set(`P:${participantId}`, canonicalKey);
        if (studentId) aliasToCanonical.set(`S:${studentId}`, canonicalKey);
        if (email) aliasToCanonical.set(`E:${String(email).trim().toLowerCase()}`, canonicalKey);
        if (enrollmentNo) aliasToCanonical.set(`N:${String(enrollmentNo).trim().toUpperCase()}`, canonicalKey);
    };

    const getOrCreateRecord = (identity) => {
        const initialKey = resolveIdentityKey(identity);
        const key = aliasToCanonical.get(initialKey) || initialKey;

        if (!participantMap.has(key)) {
            participantMap.set(key, {
                key,
                fullName: identity.fullName || '',
                email: identity.email || '',
                enrollmentNo: identity.enrollmentNo || '',
                phone: identity.phone || '',
                studentType: identity.studentType || '',
                maxMealsAllowed: identity.maxMealsAllowed ?? null,
                mealsConsumedSnapshot: identity.mealsConsumedSnapshot ?? null,
                eventEntryCount: 0,
                eventExitCount: 0,
                eventFirstEntryAt: null,
                eventLastExitAt: null,
                eventLastDirection: null,
                mealsToday: 0,
                lastMealAt: null,
                hostelEntryCount: 0,
                hostelExitCount: 0,
                hostelFirstEntryAt: null,
                hostelLastExitAt: null,
                hostelLastDirection: null,
                authCount: 0,
                failedAuthCount: 0,
                lastAuthAction: '',
                lastAuthAt: null,
            });
        }

        const row = participantMap.get(key);
        if (!row.fullName && identity.fullName) row.fullName = identity.fullName;
        if (!row.email && identity.email) row.email = identity.email;
        if (!row.enrollmentNo && identity.enrollmentNo) row.enrollmentNo = identity.enrollmentNo;
        if (!row.phone && identity.phone) row.phone = identity.phone;
        if (!row.studentType && identity.studentType) row.studentType = identity.studentType;
        if (row.maxMealsAllowed == null && identity.maxMealsAllowed != null) row.maxMealsAllowed = identity.maxMealsAllowed;
        if (row.mealsConsumedSnapshot == null && identity.mealsConsumedSnapshot != null) row.mealsConsumedSnapshot = identity.mealsConsumedSnapshot;

        addAliases(key, identity);
        return row;
    };

    for (const participant of participants) {
        getOrCreateRecord({
            participantId: participant.id,
            studentId: participant.studentId || participant.student?.id || null,
            fullName: participant.fullName || participant.student?.fullName || '',
            email: participant.email || participant.student?.email || '',
            enrollmentNo: participant.enrollmentNo || participant.student?.enrollmentNo || '',
            phone: participant.phone || participant.student?.phone || '',
            studentType: participant.student?.studentType || '',
            maxMealsAllowed: participant.maxMealsAllowed,
            mealsConsumedSnapshot: participant.mealsConsumed,
        });
    }

    for (const log of stayLogs) {
        const profile = getProfileFromEventLog(log);
        const row = getOrCreateRecord(profile);
        const direction = getDirectionLabel(log.direction);

        if (direction === 'ENTRY') {
            row.eventEntryCount += 1;
            if (!row.eventFirstEntryAt || log.scannedAt < row.eventFirstEntryAt) {
                row.eventFirstEntryAt = log.scannedAt;
            }
        }
        if (direction === 'EXIT') {
            row.eventExitCount += 1;
            if (!row.eventLastExitAt || log.scannedAt > row.eventLastExitAt) {
                row.eventLastExitAt = log.scannedAt;
            }
        }

        row.eventLastDirection = direction || row.eventLastDirection;
    }

    for (const log of mealLogs) {
        const profile = getProfileFromEventLog(log);
        const row = getOrCreateRecord(profile);
        row.mealsToday += 1;
        if (!row.lastMealAt || log.scannedAt > row.lastMealAt) {
            row.lastMealAt = log.scannedAt;
        }
    }

    for (const log of authLogs) {
        const identity = {
            participantId: null,
            studentId: log.studentId || log.student?.id || null,
            fullName: log.student?.fullName || '',
            email: log.studentEmail || log.student?.email || '',
            enrollmentNo: log.enrollmentNo || log.student?.enrollmentNo || '',
            phone: log.student?.phone || '',
            studentType: log.student?.studentType || '',
        };
        const row = getOrCreateRecord(identity);
        row.authCount += 1;
        if (getAuthStatusLabel(log.status) !== 'SUCCESS') {
            row.failedAuthCount += 1;
        }
        row.lastAuthAction = String(log.action || row.lastAuthAction || '');
        if (!row.lastAuthAt || log.createdAt > row.lastAuthAt) {
            row.lastAuthAt = log.createdAt;
        }
    }

    for (const log of hostelExitLogs) {
        const identity = {
            participantId: null,
            studentId: log.studentId || log.student?.id || null,
            fullName: log.student?.fullName || '',
            email: log.student?.email || '',
            enrollmentNo: log.student?.enrollmentNo || '',
            phone: log.student?.phone || '',
            studentType: log.student?.studentType || '',
        };
        const row = getOrCreateRecord(identity);
        const direction = getDirectionLabel(log.direction);

        if (direction === 'ENTRY') {
            row.hostelEntryCount += 1;
            if (!row.hostelFirstEntryAt || log.eventTime < row.hostelFirstEntryAt) {
                row.hostelFirstEntryAt = log.eventTime;
            }
        }
        if (direction === 'EXIT') {
            row.hostelExitCount += 1;
            if (!row.hostelLastExitAt || log.eventTime > row.hostelLastExitAt) {
                row.hostelLastExitAt = log.eventTime;
            }
        }

        row.hostelLastDirection = direction || row.hostelLastDirection;
    }

    const normalizedDayWise = normalizeDayWiseMealLimits(event.dayWiseMealLimits);
    const reportDayNumber = computeEventDayNumber(event.eventDate, new Date(`${dayKey}T12:00:00.000Z`), timezone);
    const reportDayCoupon = normalizedDayWise.find((item) => item.dayNumber === reportDayNumber)?.coupons ?? null;
    const hasDayWiseLimits = normalizedDayWise.length > 0;

    return Array.from(participantMap.values())
        .map((row) => {
            const effectiveMealLimit = hasDayWiseLimits
                ? reportDayCoupon
                : (row.maxMealsAllowed ?? event.maxMealsPerParticipant ?? null);

            return {
                name: row.fullName,
                enrollmentNo: row.enrollmentNo,
                email: row.email,
                phone: row.phone,
                studentType: row.studentType,
                eventEntries: row.eventEntryCount,
                eventExits: row.eventExitCount,
                eventMovements: row.eventEntryCount + row.eventExitCount,
                eventFirstEntryAt: formatTimestampInTimezone(row.eventFirstEntryAt, timezone),
                eventLastExitAt: formatTimestampInTimezone(row.eventLastExitAt, timezone),
                eventStatus: row.eventLastDirection === 'ENTRY' ? 'INSIDE' : (row.eventLastDirection === 'EXIT' ? 'OUTSIDE' : 'N/A'),
                mealsToday: row.mealsToday,
                lastMealAt: formatTimestampInTimezone(row.lastMealAt, timezone),
                configuredMealLimit: effectiveMealLimit == null ? 'UNLIMITED' : String(effectiveMealLimit),
                mealConsumedSnapshot: row.mealsConsumedSnapshot == null ? '' : String(row.mealsConsumedSnapshot),
                hostelEntries: row.hostelEntryCount,
                hostelExits: row.hostelExitCount,
                hostelMovements: row.hostelEntryCount + row.hostelExitCount,
                hostelFirstEntryAt: formatTimestampInTimezone(row.hostelFirstEntryAt, timezone),
                hostelLastExitAt: formatTimestampInTimezone(row.hostelLastExitAt, timezone),
                hostelStatus: row.hostelLastDirection === 'ENTRY' ? 'INSIDE' : (row.hostelLastDirection === 'EXIT' ? 'OUTSIDE' : 'N/A'),
                authActionsToday: row.authCount,
                authFailuresToday: row.failedAuthCount,
                lastAuthAction: row.lastAuthAction || '',
                lastAuthAt: formatTimestampInTimezone(row.lastAuthAt, timezone),
            };
        })
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function createEventSummary({
    event,
    dayKey,
    timezone,
    participants,
    stayLogs,
    mealLogs,
    authLogs,
    hostelExitLogs,
    participantRows,
}) {
    const activeParticipants = participants.filter((p) => p.isActive !== false);
    const hostellers = activeParticipants.filter((p) => String(p.student?.studentType || '').startsWith('HOSTELLER'));
    const dayScholars = activeParticipants.filter((p) => String(p.student?.studentType || '') === 'DAY_SCHOLAR');

    const stayEntries = stayLogs.filter((log) => getDirectionLabel(log.direction) === 'ENTRY').length;
    const stayExits = stayLogs.filter((log) => getDirectionLabel(log.direction) === 'EXIT').length;
    const mealsConfirmed = mealLogs.length;
    const authSuccess = authLogs.filter((log) => getAuthStatusLabel(log.status) === 'SUCCESS').length;
    const authFailures = authLogs.length - authSuccess;
    const hostelEntries = hostelExitLogs.filter((log) => getDirectionLabel(log.direction) === 'ENTRY').length;
    const hostelExits = hostelExitLogs.filter((log) => getDirectionLabel(log.direction) === 'EXIT').length;

    const uniqueEventMovers = new Set(participantRows.filter((row) => row.eventMovements > 0).map((row) => row.email || row.enrollmentNo || row.name)).size;
    const uniqueMealAvailed = new Set(participantRows.filter((row) => row.mealsToday > 0).map((row) => row.email || row.enrollmentNo || row.name)).size;
    const currentlyInsideEvent = participantRows.filter((row) => row.eventStatus === 'INSIDE').length;

    const reportDayNumber = computeEventDayNumber(event.eventDate, new Date(`${dayKey}T12:00:00.000Z`), timezone);
    const dayWise = normalizeDayWiseMealLimits(event.dayWiseMealLimits);
    const dayWiseCoupon = dayWise.find((item) => item.dayNumber === reportDayNumber)?.coupons ?? null;

    const peakMovementRow = participantRows
        .slice()
        .sort((a, b) => b.eventMovements - a.eventMovements)[0] || null;

    return {
        day: dayKey,
        timezone,
        participantsTotal: participants.length,
        activeParticipants: activeParticipants.length,
        hostellers: hostellers.length,
        dayScholars: dayScholars.length,
        stayEntries,
        stayExits,
        uniqueEventMovers,
        currentlyInsideEvent,
        mealsConfirmed,
        uniqueMealAvailed,
        authTotal: authLogs.length,
        authSuccess,
        authFailures,
        hostelEntries,
        hostelExits,
        eventDayNumber: reportDayNumber,
        dayWiseCouponLimit: dayWiseCoupon,
        peakMovementStudent: peakMovementRow ? peakMovementRow.name : '',
        peakMovementCount: peakMovementRow ? peakMovementRow.eventMovements : 0,
        eventStartAt: formatTimestampInTimezone(event.startTime, timezone),
        eventEndAt: formatTimestampInTimezone(event.endTime, timezone),
    };
}

function addWorksheetWithColumns(workbook, name, columns, rows) {
    const worksheet = workbook.addWorksheet(name);
    worksheet.columns = columns;
    if (rows.length > 0) {
        worksheet.addRows(rows);
    }
    worksheet.getRow(1).font = { bold: true };
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
    return worksheet;
}

async function buildEventDailyWorkbook({ eventId, date = new Date() }) {
    const {
        event,
        dayKey,
        timezone,
        participants,
        stayLogs,
        mealLogs,
        authLogs,
        hostelExitLogs,
    } = await fetchDailyData(eventId, date);

    if (!event || !dayKey) {
        throw new Error('Event not found');
    }

    const participantRows = buildParticipantReportRows({
        participants,
        stayLogs,
        mealLogs,
        authLogs,
        hostelExitLogs,
        event,
        timezone,
        dayKey,
    });

    const summary = createEventSummary({
        event,
        dayKey,
        timezone,
        participants,
        stayLogs,
        mealLogs,
        authLogs,
        hostelExitLogs,
        participantRows,
    });

    const participantActivityKeySet = buildParticipantActivityKeySet(stayLogs, mealLogs);
    const absentRows = buildAbsentRows(participants, participantActivityKeySet);
    const anomalyRows = buildAnomalyRows({
        authLogs,
        participantRows,
        eventId: event.id,
        timezone,
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'SMART-ID Backend';
    workbook.lastModifiedBy = 'SMART-ID Backend';
    workbook.created = new Date();
    workbook.modified = new Date();

    const summarySheet = workbook.addWorksheet('Daily Summary');
    summarySheet.columns = [
        { header: 'Metric', key: 'metric', width: 40 },
        { header: 'Value', key: 'value', width: 40 },
    ];
    summarySheet.addRows([
        { metric: 'Event Name', value: event.name },
        { metric: 'Date', value: summary.day },
        { metric: 'Timezone', value: summary.timezone },
        { metric: 'Event Start', value: summary.eventStartAt },
        { metric: 'Event End', value: summary.eventEndAt },
        { metric: 'Active Participants', value: summary.activeParticipants },
        { metric: 'Hostellers', value: summary.hostellers },
        { metric: 'Day Scholars', value: summary.dayScholars },
        { metric: 'Event Entries', value: summary.stayEntries },
        { metric: 'Event Exits', value: summary.stayExits },
        { metric: 'Currently Inside (Event Flow)', value: summary.currentlyInsideEvent },
        { metric: 'Unique Event Movers', value: summary.uniqueEventMovers },
        { metric: 'Meals Confirmed', value: summary.mealsConfirmed },
        { metric: 'Unique Meal Availed Students', value: summary.uniqueMealAvailed },
        { metric: 'Auth Logs Total', value: summary.authTotal },
        { metric: 'Auth Success', value: summary.authSuccess },
        { metric: 'Auth Failures', value: summary.authFailures },
        { metric: 'Hostel Gate Entries', value: summary.hostelEntries },
        { metric: 'Hostel Gate Exits', value: summary.hostelExits },
        { metric: 'Anomaly Count', value: anomalyRows.length },
        { metric: 'Absent Participants', value: absentRows.length },
        { metric: 'Event Day Number', value: summary.eventDayNumber },
        { metric: 'Day-wise Coupon Limit', value: summary.dayWiseCouponLimit == null ? 'N/A' : String(summary.dayWiseCouponLimit) },
        { metric: 'Peak Movement Student', value: summary.peakMovementStudent || 'N/A' },
        { metric: 'Peak Movement Count', value: summary.peakMovementCount },
    ]);
    summarySheet.getRow(1).font = { bold: true };

    addWorksheetWithColumns(
        workbook,
        'Participant Summary',
        [
            { header: 'Name', key: 'name', width: 24 },
            { header: 'Enrollment No', key: 'enrollmentNo', width: 18 },
            { header: 'Email', key: 'email', width: 28 },
            { header: 'Phone', key: 'phone', width: 15 },
            { header: 'Student Type', key: 'studentType', width: 16 },
            { header: 'Event Entries', key: 'eventEntries', width: 12 },
            { header: 'Event Exits', key: 'eventExits', width: 12 },
            { header: 'Event Movements', key: 'eventMovements', width: 14 },
            { header: 'First Event Entry', key: 'eventFirstEntryAt', width: 22 },
            { header: 'Last Event Exit', key: 'eventLastExitAt', width: 22 },
            { header: 'Event Status', key: 'eventStatus', width: 12 },
            { header: 'Meals Today', key: 'mealsToday', width: 12 },
            { header: 'Last Meal Time', key: 'lastMealAt', width: 22 },
            { header: 'Configured Meal Limit', key: 'configuredMealLimit', width: 20 },
            { header: 'Meal Snapshot Consumed', key: 'mealConsumedSnapshot', width: 20 },
            { header: 'Hostel Entries', key: 'hostelEntries', width: 12 },
            { header: 'Hostel Exits', key: 'hostelExits', width: 12 },
            { header: 'Hostel Movements', key: 'hostelMovements', width: 15 },
            { header: 'First Hostel Entry', key: 'hostelFirstEntryAt', width: 22 },
            { header: 'Last Hostel Exit', key: 'hostelLastExitAt', width: 22 },
            { header: 'Hostel Status', key: 'hostelStatus', width: 12 },
            { header: 'Auth Actions Today', key: 'authActionsToday', width: 15 },
            { header: 'Auth Failures Today', key: 'authFailuresToday', width: 16 },
            { header: 'Last Auth Action', key: 'lastAuthAction', width: 24 },
            { header: 'Last Auth Time', key: 'lastAuthAt', width: 22 },
        ],
        participantRows,
    );

    addWorksheetWithColumns(
        workbook,
        'Event Stay Logs',
        [
            { header: 'Timestamp', key: 'timestamp', width: 22 },
            { header: 'Direction', key: 'direction', width: 12 },
            { header: 'Gate Label', key: 'gateLabel', width: 20 },
            { header: 'Result', key: 'result', width: 12 },
            { header: 'Name', key: 'name', width: 24 },
            { header: 'Enrollment No', key: 'enrollmentNo', width: 18 },
            { header: 'Email', key: 'email', width: 28 },
            { header: 'Phone', key: 'phone', width: 15 },
            { header: 'Student Type', key: 'studentType', width: 16 },
            { header: 'Metadata', key: 'metadata', width: 60 },
        ],
        stayLogs.map((log) => {
            const profile = getProfileFromEventLog(log);
            return {
                timestamp: formatTimestampInTimezone(log.scannedAt, timezone),
                direction: getDirectionLabel(log.direction),
                gateLabel: log.gateLabel || '',
                result: log.result || '',
                name: profile.fullName || '',
                enrollmentNo: profile.enrollmentNo || '',
                email: profile.email || '',
                phone: profile.phone || '',
                studentType: profile.studentType || '',
                metadata: stringifyMetadata(log.metadata),
            };
        }),
    );

    addWorksheetWithColumns(
        workbook,
        'Meal Logs',
        [
            { header: 'Timestamp', key: 'timestamp', width: 22 },
            { header: 'Meal Number', key: 'mealNumber', width: 12 },
            { header: 'Meal Label', key: 'mealLabel', width: 18 },
            { header: 'Name', key: 'name', width: 24 },
            { header: 'Enrollment No', key: 'enrollmentNo', width: 18 },
            { header: 'Email', key: 'email', width: 28 },
            { header: 'Phone', key: 'phone', width: 15 },
            { header: 'Student Type', key: 'studentType', width: 16 },
            { header: 'Metadata', key: 'metadata', width: 60 },
        ],
        mealLogs.map((log) => {
            const profile = getProfileFromEventLog(log);
            return {
                timestamp: formatTimestampInTimezone(log.scannedAt, timezone),
                mealNumber: log.mealNumber,
                mealLabel: log.mealLabel || '',
                name: profile.fullName || '',
                enrollmentNo: profile.enrollmentNo || '',
                email: profile.email || '',
                phone: profile.phone || '',
                studentType: profile.studentType || '',
                metadata: stringifyMetadata(log.metadata),
            };
        }),
    );

    addWorksheetWithColumns(
        workbook,
        'Student Auth Logs',
        [
            { header: 'Timestamp', key: 'timestamp', width: 22 },
            { header: 'Action', key: 'action', width: 24 },
            { header: 'Status', key: 'status', width: 12 },
            { header: 'Reason', key: 'reason', width: 24 },
            { header: 'Name', key: 'name', width: 24 },
            { header: 'Enrollment No', key: 'enrollmentNo', width: 18 },
            { header: 'Email', key: 'email', width: 28 },
            { header: 'Device ID', key: 'deviceId', width: 22 },
            { header: 'Device Label', key: 'deviceLabel', width: 22 },
            { header: 'Platform', key: 'devicePlatform', width: 14 },
            { header: 'IP Address', key: 'ipAddress', width: 18 },
            { header: 'User Agent', key: 'userAgent', width: 42 },
            { header: 'Metadata', key: 'metadata', width: 60 },
        ],
        authLogs.map((log) => ({
            timestamp: formatTimestampInTimezone(log.createdAt, timezone),
            action: log.action || '',
            status: log.status || '',
            reason: log.reason || '',
            name: log.student?.fullName || '',
            enrollmentNo: log.enrollmentNo || log.student?.enrollmentNo || '',
            email: log.studentEmail || log.student?.email || '',
            deviceId: log.deviceId || '',
            deviceLabel: log.deviceLabel || '',
            devicePlatform: log.devicePlatform || '',
            ipAddress: log.ipAddress || '',
            userAgent: log.userAgent || '',
            metadata: stringifyMetadata(log.metadata),
        })),
    );

    addWorksheetWithColumns(
        workbook,
        'Hosteller Gate Logs',
        [
            { header: 'Timestamp', key: 'timestamp', width: 22 },
            { header: 'Direction', key: 'direction', width: 12 },
            { header: 'Gate', key: 'gateName', width: 18 },
            { header: 'Gate Location', key: 'gateLocation', width: 24 },
            { header: 'Name', key: 'name', width: 24 },
            { header: 'Enrollment No', key: 'enrollmentNo', width: 18 },
            { header: 'Email', key: 'email', width: 28 },
            { header: 'Student Type', key: 'studentType', width: 16 },
        ],
        hostelExitLogs.map((log) => ({
            timestamp: formatTimestampInTimezone(log.eventTime, timezone),
            direction: getDirectionLabel(log.direction),
            gateName: log.gate?.name || '',
            gateLocation: log.gate?.location || '',
            name: log.student?.fullName || '',
            enrollmentNo: log.student?.enrollmentNo || '',
            email: log.student?.email || '',
            studentType: log.student?.studentType || '',
        })),
    );

    addWorksheetWithColumns(
        workbook,
        'Anomalies',
        [
            { header: 'Category', key: 'category', width: 24 },
            { header: 'Severity', key: 'severity', width: 12 },
            { header: 'Timestamp', key: 'timestamp', width: 22 },
            { header: 'Name', key: 'name', width: 24 },
            { header: 'Enrollment No', key: 'enrollmentNo', width: 18 },
            { header: 'Email', key: 'email', width: 28 },
            { header: 'Details', key: 'details', width: 72 },
        ],
        anomalyRows,
    );

    addWorksheetWithColumns(
        workbook,
        'Absent List',
        [
            { header: 'Name', key: 'name', width: 24 },
            { header: 'Enrollment No', key: 'enrollmentNo', width: 18 },
            { header: 'Email', key: 'email', width: 28 },
            { header: 'Phone', key: 'phone', width: 15 },
            { header: 'Student Type', key: 'studentType', width: 16 },
            { header: 'Has Any Scan Today', key: 'hasAnyScanToday', width: 18 },
            { header: 'Notes', key: 'notes', width: 40 },
        ],
        absentRows,
    );

    const reportBuffer = await workbook.xlsx.writeBuffer();
    const fileName = `${sanitizeFileName(event.name)}_${dayKey}_daily_report.xlsx`;

    return {
        event,
        summary,
        fileName,
        buffer: Buffer.from(reportBuffer),
    };
}

async function buildEventDailyCsv({ eventId, date = new Date(), kind = 'combined' }) {
    const { event, stayLogs, mealLogs, dayKey } = await fetchDailyData(eventId, date);

    if (!event) {
        throw new Error('Event not found');
    }

    const dayLabel = dayKey || new Date(date).toISOString().slice(0, 10);
    const normalizedKind = String(kind || 'combined').toLowerCase();

    const stayRows = stayLogs.map((log) => {
        const profile = log.participant || log.student || {};
        return {
            date: new Date(log.scannedAt).toISOString(),
            direction: log.direction,
            gateLabel: log.gateLabel || '',
            result: log.result,
            studentName: profile.fullName || '',
            enrollmentNo: profile.enrollmentNo || '',
            email: profile.email || '',
            phone: profile.phone || '',
        };
    });

    const mealRows = mealLogs.map((log) => {
        const profile = log.participant || log.student || {};
        return {
            date: new Date(log.scannedAt).toISOString(),
            mealNumber: log.mealNumber,
            mealLabel: log.mealLabel,
            studentName: profile.fullName || '',
            enrollmentNo: profile.enrollmentNo || '',
            email: profile.email || '',
            phone: profile.phone || '',
        };
    });

    let csv;
    let fileName;

    if (normalizedKind === 'stay') {
        csv = buildCsv(
            ['date', 'direction', 'gateLabel', 'result', 'studentName', 'enrollmentNo', 'email', 'phone'],
            stayRows,
        );
        fileName = `${event.name.replace(/\s+/g, '_')}_${dayLabel}_stay.csv`;
    } else if (normalizedKind === 'meal') {
        csv = buildCsv(
            ['date', 'mealNumber', 'mealLabel', 'studentName', 'enrollmentNo', 'email', 'phone'],
            mealRows,
        );
        fileName = `${event.name.replace(/\s+/g, '_')}_${dayLabel}_meal.csv`;
    } else {
        const combinedRows = [
            ...stayRows.map((row) => ({
                type: 'STAY',
                date: row.date,
                direction: row.direction,
                mealNumber: '',
                mealLabel: '',
                gateLabel: row.gateLabel,
                result: row.result,
                studentName: row.studentName,
                enrollmentNo: row.enrollmentNo,
                email: row.email,
                phone: row.phone,
            })),
            ...mealRows.map((row) => ({
                type: 'MEAL',
                date: row.date,
                direction: '',
                mealNumber: row.mealNumber,
                mealLabel: row.mealLabel,
                gateLabel: '',
                result: 'CONFIRMED',
                studentName: row.studentName,
                enrollmentNo: row.enrollmentNo,
                email: row.email,
                phone: row.phone,
            })),
        ];

        csv = buildCsv(
            ['type', 'date', 'direction', 'mealNumber', 'mealLabel', 'gateLabel', 'result', 'studentName', 'enrollmentNo', 'email', 'phone'],
            combinedRows,
        );
        fileName = `${event.name.replace(/\s+/g, '_')}_${dayLabel}_combined.csv`;
    }

    return {
        event,
        csv,
        fileName,
        summary: {
            stayEntries: stayRows.filter((row) => row.direction === 'ENTRY').length,
            stayExits: stayRows.filter((row) => row.direction === 'EXIT').length,
            meals: mealRows.length,
            day: dayLabel,
            kind: normalizedKind,
        },
    };
}

let cachedTransport = null;
let cachedTransportKey = '';

function readSmtpConfig() {
    const host = String(process.env.SMTP_HOST || '').trim();
    const user = String(process.env.SMTP_USER || '').trim();
    const pass = String(process.env.SMTP_PASS || '').trim();
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = String(process.env.SMTP_SECURE || '').trim().toLowerCase() === 'true';

    if (!host || !user || !pass) {
        return null;
    }

    return {
        host,
        user,
        pass,
        port: Number.isFinite(port) ? port : 587,
        secure,
    };
}

function resolveMailTransport() {
    const smtp = readSmtpConfig();
    if (!smtp) return null;

    const nextKey = JSON.stringify({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        user: smtp.user,
        pass: smtp.pass,
    });

    if (cachedTransport && cachedTransportKey === nextKey) {
        return cachedTransport;
    }

    cachedTransport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        requireTLS: smtp.secure === false,
        auth: { user: smtp.user, pass: smtp.pass },
    });
    cachedTransportKey = nextKey;

    return cachedTransport;
}

function resetMailTransportCache() {
    cachedTransport = null;
    cachedTransportKey = '';
}

function shouldRetryMailSend(err) {
    const code = String(err?.code || '').toUpperCase();
    const responseCode = Number(err?.responseCode || 0);
    if (['EAUTH', 'ECONNECTION', 'ESOCKET', 'ETIMEDOUT'].includes(code)) return true;
    if (responseCode === 421 || responseCode === 454) return true;
    return false;
}

async function sendDailyEventReportForEvent(event, date = new Date()) {
    if (!event) {
        return { sent: false, skipped: true, reason: 'EVENT_MISSING' };
    }

    const recipients = Array.isArray(event.reportRecipients)
        ? event.reportRecipients.filter((email) => typeof email === 'string' && email.trim())
        : [];

    if (recipients.length === 0) {
        return { sent: false, skipped: true, reason: 'NO_RECIPIENTS' };
    }

    const transporter = resolveMailTransport();
    if (!transporter) {
        logger.warn('[EVENT-REPORT] SMTP config missing; skipping mail send', { eventId: event.id });
        return { sent: false, skipped: true, reason: 'SMTP_NOT_CONFIGURED' };
    }

    const fromAddress = String(process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
    if (!fromAddress) {
        return { sent: false, skipped: true, reason: 'SMTP_FROM_MISSING' };
    }

    const report = await buildEventDailyWorkbook({ eventId: event.id, date });
    const mailPayload = {
        from: fromAddress,
        to: recipients.join(','),
        subject: `[SMART-ID] ${event.name} Daily Excel Report (${report.summary.day})`,
        html: `<p>Daily SMART-ID Excel report attached.</p><p><strong>Event:</strong> ${event.name}</p><p><strong>Date:</strong> ${report.summary.day}</p><p><strong>Active Participants:</strong> ${report.summary.activeParticipants}</p><p><strong>Stay Entries/Exits:</strong> ${report.summary.stayEntries} / ${report.summary.stayExits}</p><p><strong>Meals Confirmed:</strong> ${report.summary.mealsConfirmed}</p><p><strong>Auth Logs (Success/Fail):</strong> ${report.summary.authSuccess} / ${report.summary.authFailures}</p><p><strong>Hostel Gate Entries/Exits:</strong> ${report.summary.hostelEntries} / ${report.summary.hostelExits}</p>`,
        attachments: [
            {
                filename: report.fileName,
                content: report.buffer,
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            },
        ],
    };

    let sendInfo;
    try {
        sendInfo = await transporter.sendMail(mailPayload);
    } catch (err) {
        if (!shouldRetryMailSend(err)) throw err;

        logger.warn('[EVENT-REPORT] Mail send failed, retrying with fresh SMTP transport', {
            eventId: event.id,
            error: err.message,
            code: err.code,
            responseCode: err.responseCode,
        });

        resetMailTransportCache();
        const retryTransporter = resolveMailTransport();
        if (!retryTransporter) {
            throw err;
        }
        sendInfo = await retryTransporter.sendMail(mailPayload);
    }

    logger.info('[EVENT-REPORT] Mail sent', {
        eventId: event.id,
        from: fromAddress,
        recipients: recipients.length,
        accepted: Array.isArray(sendInfo?.accepted) ? sendInfo.accepted.length : 0,
        messageId: sendInfo?.messageId,
    });

    return {
        sent: true,
        eventId: event.id,
        recipients: recipients.length,
        day: report.summary.day,
    };
}

async function processInBatches(items, batchSize, worker) {
    const safeBatchSize = Math.max(1, Number(batchSize) || 1);
    const results = [];

    for (let index = 0; index < items.length; index += safeBatchSize) {
        const batch = items.slice(index, index + safeBatchSize);
        const settled = await Promise.allSettled(batch.map((item) => worker(item)));
        for (let i = 0; i < settled.length; i += 1) {
            results.push({
                item: batch[i],
                settled: settled[i],
            });
        }
    }

    return results;
}

async function sendDailyEventReports(date = new Date()) {
    const events = await prisma.campusEvent.findMany({
        where: {
            isActive: true,
        },
        select: {
            id: true,
            name: true,
            reportRecipients: true,
        },
    });

    const sendConcurrency = Math.max(1, Number(process.env.EVENT_REPORT_SEND_CONCURRENCY || 3));

    const processed = await processInBatches(events, sendConcurrency, async (event) => {
        const outcome = await sendDailyEventReportForEvent(event, date);
        return { eventId: event.id, ...outcome };
    });

    const outcomes = [];
    for (const entry of processed) {
        const { item, settled } = entry;
        if (settled.status === 'fulfilled') {
            outcomes.push(settled.value);
            continue;
        }

        const errorMessage = settled.reason?.message || String(settled.reason || 'UNKNOWN_ERROR');
        logger.error('[EVENT-REPORT] Failed to send event daily report', {
            eventId: item.id,
            error: errorMessage,
        });
        outcomes.push({ eventId: item.id, sent: false, error: errorMessage });
    }

    return outcomes;
}

module.exports = {
    buildEventDailyCsv,
    buildEventDailyWorkbook,
    sendDailyEventReportForEvent,
    sendDailyEventReports,
};
