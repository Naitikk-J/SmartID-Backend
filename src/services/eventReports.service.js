const nodemailer = require('nodemailer');
const prisma = require('../config/database');
const logger = require('../config/logger');

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
    const start = startOfLocalDay(date);
    const end = endOfLocalDay(date);

    const [event, stayLogs, mealLogs] = await Promise.all([
        prisma.campusEvent.findUnique({ where: { id: eventId } }),
        prisma.eventStayScan.findMany({
            where: {
                eventId,
                scannedAt: { gte: start, lte: end },
            },
            orderBy: { scannedAt: 'asc' },
            include: {
                participant: {
                    select: {
                        fullName: true,
                        email: true,
                        phone: true,
                        enrollmentNo: true,
                    },
                },
                student: {
                    select: {
                        fullName: true,
                        email: true,
                        phone: true,
                        enrollmentNo: true,
                    },
                },
            },
        }),
        prisma.eventMealScan.findMany({
            where: {
                eventId,
                scannedAt: { gte: start, lte: end },
            },
            orderBy: { scannedAt: 'asc' },
            include: {
                participant: {
                    select: {
                        fullName: true,
                        email: true,
                        phone: true,
                        enrollmentNo: true,
                    },
                },
                student: {
                    select: {
                        fullName: true,
                        email: true,
                        phone: true,
                        enrollmentNo: true,
                    },
                },
            },
        }),
    ]);

    return { event, stayLogs, mealLogs, start, end };
}

async function buildEventDailyCsv({ eventId, date = new Date(), kind = 'combined' }) {
    const { event, stayLogs, mealLogs, start } = await fetchDailyData(eventId, date);

    if (!event) {
        throw new Error('Event not found');
    }

    const dayLabel = start.toISOString().slice(0, 10);
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

    const report = await buildEventDailyCsv({ eventId: event.id, date, kind: 'combined' });
    const mailPayload = {
        from: fromAddress,
        to: recipients.join(','),
        subject: `[SMART-ID] ${event.name} Daily Event Report (${report.summary.day})`,
        html: `<p>Daily event report attached.</p><p><strong>Event:</strong> ${event.name}</p><p><strong>Date:</strong> ${report.summary.day}</p><p><strong>Stay Entries:</strong> ${report.summary.stayEntries}</p><p><strong>Stay Exits:</strong> ${report.summary.stayExits}</p><p><strong>Meals Confirmed:</strong> ${report.summary.meals}</p>`,
        attachments: [
            {
                filename: report.fileName,
                content: report.csv,
                contentType: 'text/csv',
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

    const outcomes = [];
    for (const event of events) {
        try {
            const outcome = await sendDailyEventReportForEvent(event, date);
            outcomes.push({ eventId: event.id, ...outcome });
        } catch (err) {
            logger.error('[EVENT-REPORT] Failed to send event daily report', {
                eventId: event.id,
                error: err.message,
            });
            outcomes.push({ eventId: event.id, sent: false, error: err.message });
        }
    }

    return outcomes;
}

module.exports = {
    buildEventDailyCsv,
    sendDailyEventReportForEvent,
    sendDailyEventReports,
};
