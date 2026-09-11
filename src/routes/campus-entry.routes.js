// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Campus Entry routes
//
// Mounted at /api/v1/campus-entry. Three audiences:
//
//   STUDENT (role: STUDENT, appAccess: FULL or CAMPUS_ENTRY):
//     POST  /student/login       login-id + password (no device
//                                  binding — this is the web portal)
//     POST  /student/google      Google ID token (@ CAMPUS_ENTRY_STUDENT_DOMAIN)
//     GET   /me                  who am I
//     GET   /qr                  fresh rotating QR
//     GET   /status              have I entered yet?
//
//   SCANNER (roles: SECURITY_GUARD, EVENT_MANAGER, SUPER_ADMIN):
//     POST  /scan                verify + consume
//
//   ADMIN (roles: SUPER_ADMIN, HOD):
//     POST  /admin/enroll        bulk-import CSV rows
//     GET   /admin/scans         paginated realtime feed (with SSE)
//     GET   /admin/participants  filter+search entered/not/revoked
//     POST  /admin/revoke        clear entry lock for a participant
//     POST  /admin/resend-credentials  re-send credential emails
//     GET   /admin/credential-emails   per-recipient status
//     GET   /admin/stats         top-level counters (fast)
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { OAuth2Client } = require('google-auth-library');

const config = require('../config/env');
const prisma = require('../config/database');
const logger = require('../config/logger');
const { AppError } = require('../middleware/errorHandler');
const { authenticate, requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { authRateLimit, generalRateLimit } = require('../middleware/rateLimit');
const refreshTokenService = require('../services/refreshToken.service');
const campusEntry = require('../services/campusEntry.service');
const mailService = require('../services/mail.service');
const { emitCampusEntryScan } = require('../sockets/scanFeed.socket');
const { logAction } = require('../services/audit.service');

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────
function getStudentDomains() {
    return String(config.CAMPUS_ENTRY_STUDENT_DOMAIN || 'mitsjwl.ac.in')
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);
}

function getLoginUrl() {
    const configured = String(config.CAMPUS_ENTRY_LOGIN_URL || '').trim();
    if (configured) return configured;
    const dashboard = String(config.DASHBOARD_URL || '').split(',')[0].trim();
    return dashboard ? `${dashboard.replace(/\/$/, '')}/student/login` : '/student/login';
}

function resolveClientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
    return req.ip || req.socket?.remoteAddress || null;
}

function issueStudentTokens(student) {
    // We use `appAccess: 'CAMPUS_ENTRY'` on the payload so any legacy
    // student-only endpoints continue to check appAccess === 'FULL'
    // without accidentally admitting these web-portal tokens.
    return refreshTokenService.issueTokenPair({
        id: student.id,
        email: student.email,
        role: 'STUDENT',
        department: student.department || null,
        module: null,
        userType: student.userType || 'COLLEGE_STUDENT',
        appAccess: 'CAMPUS_ENTRY',
    });
}

// ── Zod schemas ──────────────────────────────────────────────
const studentLoginSchema = z.object({
    loginId: z.string().trim().min(3).max(160),
    password: z.string().min(1).max(200),
});

const studentGoogleSchema = z.object({
    idToken: z.string().min(20),
});

const scanSchema = z.object({
    qrToken: z.string().min(10).max(2000),
    gateLabel: z.string().trim().max(80).optional(),
    gateId: z.string().trim().max(64).optional(),
    latitude: z.coerce.number().optional(),
    longitude: z.coerce.number().optional(),
});

const enrollSchema = z.object({
    participants: z.array(z.object({
        fullName: z.string().trim().min(1),
        email: z.string().email(),
        phone: z.string().trim().max(20).optional().default(''),
        enrollmentNo: z.string().trim().max(40).optional(),
        department: z.string().trim().max(80).optional(),
        year: z.coerce.number().int().min(1).max(6).optional(),
        section: z.string().trim().max(10).optional(),
    })).min(1).max(15000),
    sendEmails: z.boolean().optional().default(true),
});

const revokeSchema = z.object({
    participantId: z.string().min(1),
    reason: z.string().trim().max(240).optional(),
});

const resendSchema = z.object({
    participantIds: z.array(z.string()).min(1).max(15000).optional(),
    onlyFailed: z.boolean().optional().default(false),
});

// ══════════════════════════════════════════════════════════════
// STUDENT ENDPOINTS
// ══════════════════════════════════════════════════════════════

/**
 * Password login. Does NOT enforce device binding — that is a
 * mobile-app constraint enforced by /auth/login. This is the web
 * campus-entry portal where a student may sign in from a shared
 * lab PC or their laptop.
 */
router.post('/student/login', authRateLimit, validate(studentLoginSchema), async (req, res, next) => {
    try {
        const loginId = String(req.body.loginId || '').trim().toLowerCase();
        const password = String(req.body.password || '');
        const ipAddress = resolveClientIp(req);

        // Match by email first, then by enrollmentNo (many students will
        // find it easier to remember their enrollment than an email).
        let student = await prisma.student.findFirst({
            where: {
                OR: [
                    { email: loginId },
                    { enrollmentNo: loginId.toUpperCase() },
                ],
            },
        });

        // Preserve constant-time-ish behaviour: run a dummy bcrypt if
        // the account doesn't exist so timing doesn't leak enrollment.
        const hashToCheck = student?.passwordHash
            || '$2a$10$aaaaaaaaaaaaaaaaaaaaaOaeaeaeaeaeaeaeaeaeaeaeaeaeaeaea';
        const ok = await bcrypt.compare(password, hashToCheck);

        if (!student || !ok) {
            await prisma.studentAuthLog.create({
                data: {
                    studentId: student?.id || null,
                    studentEmail: loginId,
                    action: 'CAMPUS_ENTRY_LOGIN_FAILURE',
                    status: 'FAILED',
                    reason: student ? 'INVALID_PASSWORD' : 'UNKNOWN_EMAIL',
                    ipAddress,
                    userAgent: req.headers['user-agent'] || null,
                },
            }).catch(() => {});
            throw new AppError('Invalid login id or password', 401, 'INVALID_CREDENTIALS');
        }
        if (!student.isActive) {
            throw new AppError('Account is deactivated', 401, 'ACCOUNT_INACTIVE');
        }

        await prisma.student.update({
            where: { id: student.id },
            data: { lastLoginAt: new Date() },
        }).catch(() => {});

        const tokens = issueStudentTokens(student);

        await prisma.studentAuthLog.create({
            data: {
                studentId: student.id,
                studentEmail: student.email,
                enrollmentNo: student.enrollmentNo,
                action: 'CAMPUS_ENTRY_LOGIN_SUCCESS',
                status: 'SUCCESS',
                ipAddress,
                userAgent: req.headers['user-agent'] || null,
                metadata: { mode: 'password' },
            },
        }).catch(() => {});

        res.json({
            success: true,
            data: {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                user: {
                    id: student.id,
                    role: 'STUDENT',
                    appAccess: 'CAMPUS_ENTRY',
                    name: student.fullName,
                    email: student.email,
                    enrollmentNo: student.enrollmentNo,
                    department: student.department,
                    year: student.year,
                    photoUrl: student.photoUrl || null,
                },
            },
        });
    } catch (err) {
        next(err);
    }
});

/**
 * Google Identity Services callback. The idToken is verified against
 * Google's public keys, and the email domain is checked against
 * CAMPUS_ENTRY_STUDENT_DOMAIN. If the student doesn't exist, we
 * REJECT (the admin must have bulk-imported them first — otherwise
 * anyone with a matching @-domain address could self-enrol).
 */
router.post('/student/google', authRateLimit, validate(studentGoogleSchema), async (req, res, next) => {
    try {
        const idToken = String(req.body.idToken || '').trim();
        const ipAddress = resolveClientIp(req);
        const googleClientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
        if (!googleClientId) {
            throw new AppError('Google sign-in not configured', 503, 'GOOGLE_NOT_CONFIGURED');
        }

        const client = new OAuth2Client(googleClientId);
        let payload;
        try {
            const ticket = await client.verifyIdToken({
                idToken,
                audience: googleClientId,
            });
            payload = ticket.getPayload();
        } catch (err) {
            throw new AppError('Invalid Google credential', 401, 'INVALID_GOOGLE_TOKEN');
        }

        const email = String(payload?.email || '').trim().toLowerCase();
        if (!email || !payload?.email_verified) {
            throw new AppError('Google account email is not verified', 401, 'EMAIL_UNVERIFIED');
        }

        const domains = getStudentDomains();
        const matches = domains.some((d) => email.endsWith(`@${d}`));
        if (!matches) {
            throw new AppError(
                `Use your official student email (@${domains[0]})`,
                403,
                'DOMAIN_NOT_ALLOWED',
            );
        }

        const student = await prisma.student.findUnique({ where: { email } });
        if (!student || !student.isActive) {
            await prisma.studentAuthLog.create({
                data: {
                    studentEmail: email,
                    action: 'CAMPUS_ENTRY_GOOGLE_FAILURE',
                    status: 'FAILED',
                    reason: 'NOT_ENROLLED',
                    ipAddress,
                    userAgent: req.headers['user-agent'] || null,
                },
            }).catch(() => {});
            throw new AppError(
                'You are not enrolled for campus entry. Contact the admin.',
                403,
                'NOT_ENROLLED',
            );
        }

        // Persist googleId + googleEmail so any future admin audit can
        // link this OAuth identity to the local student record.
        await prisma.student.update({
            where: { id: student.id },
            data: {
                googleId: payload.sub || student.googleId,
                googleEmail: email,
                lastLoginAt: new Date(),
            },
        }).catch(() => {});

        const tokens = issueStudentTokens(student);

        await prisma.studentAuthLog.create({
            data: {
                studentId: student.id,
                studentEmail: student.email,
                enrollmentNo: student.enrollmentNo,
                action: 'CAMPUS_ENTRY_GOOGLE_SUCCESS',
                status: 'SUCCESS',
                ipAddress,
                userAgent: req.headers['user-agent'] || null,
                metadata: { mode: 'google', sub: payload.sub || null },
            },
        }).catch(() => {});

        res.json({
            success: true,
            data: {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                user: {
                    id: student.id,
                    role: 'STUDENT',
                    appAccess: 'CAMPUS_ENTRY',
                    name: student.fullName,
                    email: student.email,
                    enrollmentNo: student.enrollmentNo,
                    department: student.department,
                    year: student.year,
                    photoUrl: student.photoUrl || null,
                },
            },
        });
    } catch (err) {
        next(err);
    }
});

/**
 * Guard: reject anything except a student token that came from the
 * campus-entry portal. Prevents an admin token from accidentally
 * hitting these endpoints.
 */
function requireCampusEntryStudent(req, _res, next) {
    if (req.user?.role !== 'STUDENT') {
        return next(new AppError('Student token required', 403, 'FORBIDDEN'));
    }
    // Allow both CAMPUS_ENTRY (web portal) and FULL (mobile) tokens.
    if (req.user.appAccess && !['CAMPUS_ENTRY', 'FULL'].includes(req.user.appAccess)) {
        return next(new AppError('Insufficient app access', 403, 'FORBIDDEN'));
    }
    next();
}

router.get('/me', authenticate, requireCampusEntryStudent, async (req, res, next) => {
    try {
        const student = await prisma.student.findUnique({
            where: { id: req.user.id },
            select: {
                id: true,
                fullName: true,
                email: true,
                enrollmentNo: true,
                department: true,
                year: true,
                section: true,
                photoUrl: true,
            },
        });
        if (!student) throw new AppError('Session invalid', 401, 'INVALID_TOKEN');
        res.json({ success: true, data: student });
    } catch (err) {
        next(err);
    }
});

/**
 * Return a fresh rotating QR. HMAC-signed, stateless — this is the
 * hot path. Rate limited (generalRateLimit) so a runaway client can't
 * DoS the server.
 */
router.get('/qr', authenticate, requireCampusEntryStudent, async (req, res, next) => {
    try {
        const result = await campusEntry.mintQrForStudent(req.user.id);
        res.set('Cache-Control', 'no-store');
        res.json({
            success: true,
            data: {
                token: result.token,
                // NB: expiresAt is intentionally NOT surfaced to the UI as
                // a countdown per spec. The client refreshes on a fixed
                // schedule below the TTL.
                ttlSeconds: result.ttlSeconds,
                alreadyUsed: result.alreadyUsed,
                participant: result.participant,
            },
        });
    } catch (err) {
        if (err?.statusCode) return next(new AppError(err.message, err.statusCode, err.code));
        next(err);
    }
});

router.get('/status', authenticate, requireCampusEntryStudent, async (req, res, next) => {
    try {
        const eventId = await campusEntry.getOrCreateEvergreenEvent();
        const participant = await prisma.eventParticipant.findFirst({
            where: { eventId, studentId: req.user.id },
            select: {
                id: true,
                entryUsedAt: true,
                entryRevokedAt: true,
                entryRevokeCount: true,
                isActive: true,
            },
        });
        res.json({
            success: true,
            data: {
                enrolled: Boolean(participant),
                entered: Boolean(participant?.entryUsedAt),
                enteredAt: participant?.entryUsedAt || null,
                revokedAt: participant?.entryRevokedAt || null,
                active: Boolean(participant?.isActive),
            },
        });
    } catch (err) {
        next(err);
    }
});

// ══════════════════════════════════════════════════════════════
// SCANNER ENDPOINT
// ══════════════════════════════════════════════════════════════

router.post(
    '/scan',
    authenticate,
    requireRole('SECURITY_GUARD', 'EVENT_MANAGER', 'SUPER_ADMIN', 'HOD'),
    generalRateLimit,
    validate(scanSchema),
    async (req, res, next) => {
        try {
            const started = Date.now();
            const result = await campusEntry.verifyAndConsumeQr({
                rawToken: req.body.qrToken,
                scannedById: req.user.id,
                gateId: req.body.gateId || null,
                metadata: {
                    gateLabel: req.body.gateLabel || null,
                    latitude: req.body.latitude || null,
                    longitude: req.body.longitude || null,
                    scannerEmail: req.user.email,
                },
            });
            const processingMs = Date.now() - started;

            // Broadcast to the admin feed.
            if (result.ok) {
                emitCampusEntryScan({
                    ok: true,
                    reason: result.reason,
                    scanId: result.scanId,
                    participantId: result.participantId,
                    student: result.student,
                    gateLabel: req.body.gateLabel || null,
                    scannedBy: req.user.email,
                    scannedAt: result.scannedAt,
                    processingMs,
                });
            } else if (result.reason === 'ALREADY_ENTERED') {
                // Surface duplicate attempts so admins can see them too.
                emitCampusEntryScan({
                    ok: false,
                    reason: 'ALREADY_ENTERED',
                    student: result.student || null,
                    gateLabel: req.body.gateLabel || null,
                    scannedBy: req.user.email,
                    processingMs,
                    badge: 'AMBER',
                });
            }

            res.json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    },
);

// ══════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS
// ══════════════════════════════════════════════════════════════

// Threshold above which we run enroll in the background instead of
// blocking the HTTP request. Roughly matches "well under 60s at
// bcrypt cost 8" so a synchronous response stays within any sensible
// proxy timeout.
const SYNC_ENROLL_THRESHOLD = 500;

router.post(
    '/admin/enroll',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD'),
    validate(enrollSchema),
    async (req, res, next) => {
        try {
            const { participants, sendEmails } = req.body;
            const loginUrl = getLoginUrl();
            const smtpReady = mailService.isSmtpConfigured();

            // ── Async path: > threshold rows ────────────────────
            // 10k students × bcrypt-8 ≈ 2.5 min. Doing that in-band
            // would time out the HTTP request and the admin would
            // never see the summary. Instead we validate the
            // envelope, respond "queued", and process in a
            // detached task. Progress is visible via /admin/stats.
            if (participants.length > SYNC_ENROLL_THRESHOLD) {
                await logAction(req, {
                    action: 'CAMPUS_ENTRY_BULK_ENROLL_QUEUED',
                    entity: 'CampusEvent',
                    entityId: null,
                    userId: req.user.id,
                    newValue: { rows: participants.length, sendEmails },
                }).catch(() => {});

                setImmediate(async () => {
                    try {
                        const enroll = await campusEntry.enrollParticipants(participants, {
                            requestedById: req.user.id,
                        });
                        logger.info('[CAMPUS-ENTRY] async enroll complete', {
                            requestedById: req.user.id,
                            ...enroll.summary,
                        });
                        if (sendEmails && smtpReady && enroll.mailerRows.length > 0) {
                            await mailService.sendCredentialsBatch(enroll.mailerRows, {
                                loginUrl,
                                requestedById: req.user.id,
                                concurrency: 5,
                            });
                        }
                    } catch (err) {
                        logger.error('[CAMPUS-ENTRY] async enroll failed', {
                            error: err?.message,
                        });
                    }
                });

                return res.status(202).json({
                    success: true,
                    data: {
                        queued: true,
                        rows: participants.length,
                        note: 'Enrolling in the background. Watch the counters + Credential Emails tab for progress.',
                        mailKickoff: sendEmails ? (smtpReady ? 'started' : 'skipped_no_smtp') : 'skipped',
                    },
                });
            }

            // ── Sync path: small imports ────────────────────────
            const enroll = await campusEntry.enrollParticipants(participants, {
                requestedById: req.user.id,
            });

            let mailKickoff = 'skipped';
            if (sendEmails && enroll.mailerRows.length > 0) {
                if (!smtpReady) {
                    mailKickoff = 'skipped_no_smtp';
                } else {
                    mailKickoff = 'started';
                    setImmediate(() => {
                        mailService
                            .sendCredentialsBatch(enroll.mailerRows, {
                                loginUrl,
                                requestedById: req.user.id,
                                concurrency: 5,
                            })
                            .catch((err) => logger.warn('[CAMPUS-ENTRY] mailer batch failed', {
                                error: err?.message,
                            }));
                    });
                }
            }

            await logAction(req, {
                action: 'CAMPUS_ENTRY_BULK_ENROLL',
                entity: 'CampusEvent',
                entityId: enroll.eventId,
                userId: req.user.id,
                newValue: { summary: enroll.summary, mailKickoff },
            }).catch(() => {});

            res.json({
                success: true,
                data: {
                    eventId: enroll.eventId,
                    summary: enroll.summary,
                    mailKickoff,
                },
            });
        } catch (err) {
            next(err);
        }
    },
);

router.get(
    '/admin/scans',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD', 'FACULTY'),
    async (req, res, next) => {
        try {
            const { limit, cursor, since, search } = req.query;
            const result = await campusEntry.listScans({
                limit: Number(limit) || 50,
                cursor: cursor || null,
                since: since || null,
                search: search || null,
            });
            res.json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    },
);

router.get(
    '/admin/participants',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD', 'FACULTY'),
    async (req, res, next) => {
        try {
            const { limit, cursor, filter, search } = req.query;
            const result = await campusEntry.listParticipants({
                limit: Number(limit) || 50,
                cursor: cursor || null,
                filter: filter || null,
                search: search || null,
            });
            res.json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    },
);

router.post(
    '/admin/revoke',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD'),
    validate(revokeSchema),
    async (req, res, next) => {
        try {
            const result = await campusEntry.revokeEntry({
                participantId: req.body.participantId,
                revokedById: req.user.id,
                reason: req.body.reason || null,
                req,
            });
            res.json({ success: true, data: result });
        } catch (err) {
            if (err?.statusCode) return next(new AppError(err.message, err.statusCode, err.code));
            next(err);
        }
    },
);

router.post(
    '/admin/resend-credentials',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD'),
    validate(resendSchema),
    async (req, res, next) => {
        try {
            const eventId = await campusEntry.getOrCreateEvergreenEvent();
            if (!eventId) {
                throw new AppError('Campus entry not initialised', 503, 'NOT_INITIALISED');
            }
            const { participantIds, onlyFailed } = req.body;

            // Build the target list. If onlyFailed, pick participants
            // whose last email status was FAILED (or who never got a
            // status row at all).
            let targets = [];
            if (Array.isArray(participantIds) && participantIds.length > 0) {
                targets = await prisma.eventParticipant.findMany({
                    where: { eventId, id: { in: participantIds } },
                });
            } else if (onlyFailed) {
                // Find participants whose latest CredentialEmailStatus is
                // FAILED. Prisma+Mongo doesn't reliably support `distinct`
                // on a select, so we group and dedupe in JS.
                const failed = await prisma.credentialEmailStatus.groupBy({
                    by: ['participantId'],
                    where: { eventId, status: 'FAILED' },
                    _max: { updatedAt: true },
                });
                const ids = failed.map((r) => r.participantId).filter(Boolean);
                if (ids.length === 0) {
                    return res.json({ success: true, data: { queued: 0, note: 'No failed emails to resend.' } });
                }
                targets = await prisma.eventParticipant.findMany({
                    where: { eventId, id: { in: ids } },
                });
            } else {
                throw new AppError('Provide participantIds or onlyFailed=true', 400, 'INVALID_REQUEST');
            }

            if (targets.length === 0) {
                return res.json({ success: true, data: { queued: 0 } });
            }

            // Rotate every target's password so the newly-emailed one
            // is authoritative. Anyone still holding the old email
            // gets locked out — this is the correct behaviour.
            const rows = [];
            for (const p of targets) {
                const newPassword = campusEntry.generatePassword(10);
                const passwordHash = await bcrypt.hash(newPassword, 10);
                if (p.studentId) {
                    await prisma.student.update({
                        where: { id: p.studentId },
                        data: { passwordHash },
                    }).catch((err) => logger.warn('[CAMPUS-ENTRY] resend: Student.update failed', {
                        id: p.studentId, error: err.message,
                    }));
                }
                await prisma.eventParticipant.update({
                    where: { id: p.id },
                    data: { passwordHint: newPassword, credentialsIssuedAt: new Date() },
                }).catch(() => {});
                rows.push({
                    participantId: p.id,
                    eventId,
                    studentId: p.studentId || null,
                    email: p.email,
                    fullName: p.fullName,
                    loginId: p.loginId || p.email,
                    password: newPassword,
                    enrollmentNo: p.enrollmentNo,
                });
            }

            const loginUrl = getLoginUrl();
            setImmediate(() => {
                mailService
                    .sendCredentialsBatch(rows, {
                        loginUrl,
                        requestedById: req.user.id,
                        concurrency: 5,
                    })
                    .catch((err) => logger.warn('[CAMPUS-ENTRY] resend batch failed', { error: err?.message }));
            });

            await logAction(req, {
                action: 'CAMPUS_ENTRY_RESEND_CREDENTIALS',
                entity: 'CampusEvent',
                entityId: eventId,
                userId: req.user.id,
                newValue: { count: rows.length, onlyFailed: Boolean(onlyFailed) },
            }).catch(() => {});

            res.json({ success: true, data: { queued: rows.length } });
        } catch (err) {
            next(err);
        }
    },
);

router.get(
    '/admin/credential-emails',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD'),
    async (req, res, next) => {
        try {
            const eventId = await campusEntry.getOrCreateEvergreenEvent();
            if (!eventId) return res.json({ success: true, data: { rows: [], summary: {} } });

            const status = req.query.status ? String(req.query.status).toUpperCase() : null;
            const where = { eventId };
            if (status && ['QUEUED', 'SENT', 'FAILED'].includes(status)) where.status = status;

            const [rows, summary] = await Promise.all([
                prisma.credentialEmailStatus.findMany({
                    where,
                    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
                    take: 200,
                    select: {
                        id: true,
                        participantId: true,
                        email: true,
                        status: true,
                        attempts: true,
                        lastError: true,
                        sentAt: true,
                        updatedAt: true,
                        createdAt: true,
                    },
                }),
                prisma.credentialEmailStatus.groupBy({
                    by: ['status'],
                    where: { eventId },
                    _count: { _all: true },
                }),
            ]);

            const summaryMap = { SENT: 0, FAILED: 0, QUEUED: 0 };
            for (const s of summary) summaryMap[s.status] = s._count._all;

            res.json({ success: true, data: { rows, summary: summaryMap } });
        } catch (err) {
            next(err);
        }
    },
);

router.get(
    '/admin/stats',
    authenticate,
    requireRole('SUPER_ADMIN', 'HOD', 'FACULTY'),
    async (req, res, next) => {
        try {
            const eventId = await campusEntry.getOrCreateEvergreenEvent();
            if (!eventId) {
                return res.json({ success: true, data: { enrolled: 0, entered: 0, notEntered: 0, revokes: 0, mail: {} } });
            }
            const [enrolled, entered, revokes, mail] = await Promise.all([
                prisma.eventParticipant.count({ where: { eventId, isActive: true } }),
                prisma.eventParticipant.count({ where: { eventId, entryUsedAt: { not: null } } }),
                prisma.eventParticipant.aggregate({
                    where: { eventId, entryRevokeCount: { gt: 0 } },
                    _sum: { entryRevokeCount: true },
                    _count: { _all: true },
                }),
                prisma.credentialEmailStatus.groupBy({
                    by: ['status'],
                    where: { eventId },
                    _count: { _all: true },
                }),
            ]);
            const mailMap = { SENT: 0, FAILED: 0, QUEUED: 0 };
            for (const s of mail) mailMap[s.status] = s._count._all;
            res.json({
                success: true,
                data: {
                    enrolled,
                    entered,
                    notEntered: Math.max(0, enrolled - entered),
                    revokes: revokes._count._all || 0,
                    totalRevokeCount: revokes._sum?.entryRevokeCount || 0,
                    mail: mailMap,
                    smtpConfigured: mailService.isSmtpConfigured(),
                },
            });
        } catch (err) {
            next(err);
        }
    },
);

module.exports = router;
