// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Transactional mail service (Nodemailer / SMTP)
//
// This is the mail transport for user-facing transactional mail
// (currently: campus-entry credential emails). It is SEPARATE from
// eventReports.service.js which owns the scheduled Excel-report
// mails to admins — kept apart so a bug in one channel cannot
// starve the other of retries.
//
// Delivery is best-effort with per-recipient persistence: every
// send attempt updates a `CredentialEmailStatus` row, so admins can
// query the failure list and trigger a targeted resend. That is
// the "fallback for failed emails" from the spec.
// ═══════════════════════════════════════════════════════════════

const nodemailer = require('nodemailer');
const config = require('../config/env');
const logger = require('../config/logger');
const prisma = require('../config/database');

// ── SMTP transport (cached, invalidated on credential rotation) ─
let cachedTransport = null;
let cachedTransportKey = '';

function readSmtpConfig() {
    const host = String(process.env.SMTP_HOST || '').trim();
    const user = String(process.env.SMTP_USER || '').trim();
    const pass = String(process.env.SMTP_PASS || '').trim();
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = String(process.env.SMTP_SECURE || '').trim().toLowerCase() === 'true';
    if (!host || !user || !pass) return null;
    return {
        host,
        user,
        pass,
        port: Number.isFinite(port) ? port : 587,
        secure,
    };
}

function getTransport() {
    const smtp = readSmtpConfig();
    if (!smtp) return null;

    const key = JSON.stringify(smtp);
    if (cachedTransport && cachedTransportKey === key) return cachedTransport;

    cachedTransport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        requireTLS: smtp.secure === false,
        auth: { user: smtp.user, pass: smtp.pass },
        // Pool connections so bulk sends reuse a small handful of
        // sockets instead of opening one per recipient.
        pool: true,
        maxConnections: 5,
        maxMessages: 100,
    });
    cachedTransportKey = key;
    return cachedTransport;
}

function resetTransportCache() {
    cachedTransport = null;
    cachedTransportKey = '';
}

function shouldRetry(err) {
    const code = String(err?.code || '').toUpperCase();
    const responseCode = Number(err?.responseCode || 0);
    if (['EAUTH', 'ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'EDNS'].includes(code)) return true;
    if ([421, 450, 451, 452, 454].includes(responseCode)) return true;
    return false;
}

function getFromAddress() {
    return String(process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
}

function isSmtpConfigured() {
    return Boolean(readSmtpConfig()) && Boolean(getFromAddress());
}

// ── Credential email template ───────────────────────────────
// Kept as inline HTML so we don't need a template engine. Values
// are stringified and HTML-escaped defensively.
function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderCredentialsEmail({ fullName, loginId, password, loginUrl, enrollmentNo }) {
    const safeName = escapeHtml(fullName || 'Student');
    const safeLoginId = escapeHtml(loginId);
    const safePassword = escapeHtml(password);
    const safeUrl = escapeHtml(loginUrl);
    const safeEnroll = escapeHtml(enrollmentNo || '');

    const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#111827;">
  <table role="presentation" width="100%" style="max-width:560px;margin:32px auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.08);">
    <tr><td style="padding:28px 32px;background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%);color:#fff;">
      <div style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;opacity:0.85;">MITS Smart ID</div>
      <div style="font-size:22px;font-weight:700;margin-top:6px;">Your Campus Entry Login</div>
    </td></tr>
    <tr><td style="padding:28px 32px;">
      <p style="margin:0 0 16px;font-size:15px;">Hello <strong>${safeName}</strong>,</p>
      <p style="margin:0 0 20px;font-size:14px;line-height:1.55;color:#374151;">
        Your account for the MITS Smart&nbsp;ID campus-entry portal is ready. Use the credentials below to sign in and show your dynamic entry QR at the gate.
      </p>
      <table role="presentation" width="100%" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;font-size:14px;">
        ${safeEnroll ? `<tr><td style="padding:6px 0;color:#6b7280;">Enrollment</td><td style="padding:6px 0;font-weight:600;">${safeEnroll}</td></tr>` : ''}
        <tr><td style="padding:6px 0;color:#6b7280;">Login ID</td><td style="padding:6px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600;">${safeLoginId}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Password</td><td style="padding:6px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600;">${safePassword}</td></tr>
      </table>
      <div style="text-align:center;margin:24px 0 12px;">
        <a href="${safeUrl}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:8px;">Open Smart ID Portal</a>
      </div>
      <p style="margin:20px 0 0;font-size:12px;line-height:1.55;color:#6b7280;">
        Keep this password private. Your QR is system-generated and rotates automatically — a screenshot is not usable at the gate.
      </p>
    </td></tr>
    <tr><td style="padding:16px 32px;background:#f9fafb;color:#9ca3af;font-size:11px;text-align:center;">
      This is an automated message from Madhav Institute of Technology &amp; Science.
    </td></tr>
  </table>
</body></html>`;

    const text = [
        `Hello ${fullName || 'Student'},`,
        '',
        'Your MITS Smart ID campus-entry login is ready.',
        enrollmentNo ? `Enrollment: ${enrollmentNo}` : null,
        `Login ID: ${loginId}`,
        `Password: ${password}`,
        '',
        `Sign in: ${loginUrl}`,
        '',
        'Keep this password private. Your QR is system-generated and rotates automatically.',
    ].filter(Boolean).join('\n');

    return { html, text };
}

/**
 * Send one credential email. Returns { ok, error } — never throws.
 * On failure the caller is expected to persist FAILED to
 * CredentialEmailStatus and retry later; retry logic lives in
 * sendCredentialsBatch below so this stays a tight primitive.
 */
async function sendCredentialsEmail({ to, fullName, loginId, password, loginUrl, enrollmentNo }) {
    if (!isSmtpConfigured()) {
        return { ok: false, error: 'SMTP_NOT_CONFIGURED', permanent: true };
    }
    const transport = getTransport();
    if (!transport) {
        return { ok: false, error: 'SMTP_NOT_CONFIGURED', permanent: true };
    }
    const { html, text } = renderCredentialsEmail({
        fullName,
        loginId,
        password,
        loginUrl,
        enrollmentNo,
    });

    try {
        const info = await transport.sendMail({
            from: getFromAddress(),
            to,
            subject: 'Your MITS Smart ID login',
            html,
            text,
        });
        return { ok: true, messageId: info?.messageId, accepted: info?.accepted, rejected: info?.rejected };
    } catch (err) {
        // On transient errors, drop the cached transport so the next
        // attempt gets a fresh socket. This has rescued us from
        // hung EAUTH pools in the eventReports flow.
        if (shouldRetry(err)) {
            resetTransportCache();
        }
        return {
            ok: false,
            error: err?.message || 'MAIL_SEND_FAILED',
            code: err?.code,
            responseCode: err?.responseCode,
            retryable: shouldRetry(err),
        };
    }
}

/**
 * Send credentials to a list of participants with concurrency-limited
 * parallelism and per-recipient status persistence. Designed for the
 * bulk-import-then-email flow: at 10k students we do NOT block the
 * request — the caller should invoke this on a background tick and
 * check status via the admin endpoint.
 *
 * @param {Array} rows [{ participantId, eventId, studentId?, email, fullName, loginId, password, enrollmentNo? }]
 * @param {Object} opts { loginUrl, concurrency = 5, requestedById?, maxAttempts = 3 }
 */
async function sendCredentialsBatch(rows, opts = {}) {
    const {
        loginUrl,
        concurrency = 5,
        requestedById = null,
        maxAttempts = 3,
    } = opts;

    if (!Array.isArray(rows) || rows.length === 0) {
        return { sent: 0, failed: 0, statuses: [] };
    }

    if (!isSmtpConfigured()) {
        logger.warn('[MAIL] SMTP not configured — persisting all rows as FAILED');
    }

    const results = [];
    let index = 0;
    let sent = 0;
    let failed = 0;

    async function worker() {
        while (true) {
            const i = index++;
            if (i >= rows.length) return;
            const row = rows[i];

            // Upsert a status record so retries update instead of piling up.
            let statusRow = null;
            try {
                statusRow = await prisma.credentialEmailStatus.create({
                    data: {
                        participantId: row.participantId,
                        eventId: row.eventId,
                        studentId: row.studentId || null,
                        email: row.email,
                        status: 'QUEUED',
                        attempts: 0,
                        requestedById,
                    },
                });
            } catch (err) {
                logger.warn('[MAIL] Failed to create CredentialEmailStatus', {
                    participantId: row.participantId,
                    error: err.message,
                });
            }

            let attempt = 0;
            let lastResult = null;
            while (attempt < maxAttempts) {
                attempt += 1;
                lastResult = await sendCredentialsEmail({
                    to: row.email,
                    fullName: row.fullName,
                    loginId: row.loginId,
                    password: row.password,
                    loginUrl,
                    enrollmentNo: row.enrollmentNo,
                });
                if (lastResult.ok) break;
                if (lastResult.permanent) break;
                if (!lastResult.retryable) break;
                // Simple linear backoff (500ms, 1s, 2s).
                await new Promise((r) => setTimeout(r, 500 * attempt));
            }

            if (statusRow) {
                try {
                    await prisma.credentialEmailStatus.update({
                        where: { id: statusRow.id },
                        data: {
                            status: lastResult.ok ? 'SENT' : 'FAILED',
                            attempts: attempt,
                            lastError: lastResult.ok ? null : String(lastResult.error || 'UNKNOWN').slice(0, 500),
                            lastAttemptAt: new Date(),
                            sentAt: lastResult.ok ? new Date() : null,
                        },
                    });
                } catch (err) {
                    logger.warn('[MAIL] Failed to update CredentialEmailStatus', {
                        id: statusRow.id,
                        error: err.message,
                    });
                }
            }

            if (lastResult.ok) sent += 1; else failed += 1;
            results.push({
                participantId: row.participantId,
                email: row.email,
                ok: lastResult.ok,
                error: lastResult.ok ? null : lastResult.error,
                attempts: attempt,
            });
        }
    }

    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, rows.length)) }, () => worker());
    await Promise.all(workers);

    logger.info('[MAIL] Credential batch complete', {
        total: rows.length,
        sent,
        failed,
        concurrency,
    });

    return { sent, failed, statuses: results };
}

module.exports = {
    isSmtpConfigured,
    sendCredentialsEmail,
    sendCredentialsBatch,
    renderCredentialsEmail, // exported for testing
    resetTransportCache,
};
