// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Campus Entry Service
//
// One evergreen `CampusEvent` anchors the entire student daily-entry
// flow. Every bulk-imported student becomes an `EventParticipant` of
// that event, and the participant row carries the single-entry lock
// (entryUsedAt / entryScanId / entryRevoked*).
//
// Concurrency contract:
//   verifyAndConsumeQr uses `updateMany({ entryUsedAt: null })` so a
//   race between two scanners (or a double-fire from one) only ever
//   consumes the lock ONCE. The loser sees ALREADY_ENTERED. This is
//   what lets us serve 10k students without pessimistic locks.
// ═══════════════════════════════════════════════════════════════

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../config/database');
const config = require('../config/env');
const logger = require('../config/logger');
const {
    createParticipantQrToken,
    verifyEventQrToken,
} = require('./eventQrToken.service');
const { logAction } = require('./audit.service');

const EVERGREEN_EVENT_TAG = 'CAMPUS_ENTRY_EVERGREEN';

// Cache the event id in-process so hot paths (QR mint, scan verify)
// don't hit Mongo just to look up a constant. Invalidated on process
// restart which is exactly when a re-seed can happen.
let cachedEvergreenEventId = null;
let cachedAt = 0;

function isCacheFresh() {
    // Refresh once per hour so a manual delete + recreate is picked
    // up without needing a full restart.
    return cachedEvergreenEventId && (Date.now() - cachedAt) < 60 * 60 * 1000;
}

/**
 * Return the id of the evergreen campus-entry event, creating it if
 * it doesn't exist. Idempotent — safe to call on every server boot.
 *
 * The event is intentionally shaped as an "always active" stay event
 * (isStayHostel=false, exitMode=SINGLE, appliesTo=[ALL]) so it does
 * not accidentally match any of the existing stay-hostel special
 * cases in events.routes.js.
 */
async function getOrCreateEvergreenEvent() {
    if (isCacheFresh()) return cachedEvergreenEventId;

    const eventName = config.CAMPUS_ENTRY_EVENT_NAME || 'MITS Campus Entry';

    // Look up by a marker inside description so we can rename the
    // event without losing the anchor. Fall back to name if the
    // marker isn't present yet.
    const existing = await prisma.campusEvent.findFirst({
        where: {
            OR: [
                { description: { contains: EVERGREEN_EVENT_TAG } },
                { name: eventName },
            ],
        },
        select: { id: true, description: true, name: true },
    });

    if (existing) {
        // Backfill the tag if this event was created before we added the
        // marker, so future lookups are unambiguous.
        if (!existing.description || !existing.description.includes(EVERGREEN_EVENT_TAG)) {
            await prisma.campusEvent.update({
                where: { id: existing.id },
                data: {
                    description: `${existing.description || ''}\n[${EVERGREEN_EVENT_TAG}]`.trim(),
                },
            });
        }
        cachedEvergreenEventId = existing.id;
        cachedAt = Date.now();
        return existing.id;
    }

    // Need a createdById — grab the first active super admin. If there
    // are none yet (fresh install), we defer creation until one exists.
    const superAdmin = await prisma.adminUser.findFirst({
        where: { role: 'SUPER_ADMIN', isActive: true },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
    });
    if (!superAdmin) {
        logger.warn('[CAMPUS-ENTRY] No SUPER_ADMIN exists yet — evergreen event will be seeded on first admin login.');
        return null;
    }

    // Wide window so the event is always "active".
    const now = new Date();
    const farFuture = new Date('2099-12-31T23:59:59.000Z');

    const created = await prisma.campusEvent.create({
        data: {
            name: eventName,
            description: `Daily student campus-entry pass anchor. [${EVERGREEN_EVENT_TAG}]`,
            isStayHostel: false,
            eventDate: now,
            startTime: now,
            endTime: farFuture,
            exitMode: 'SINGLE',
            appliesTo: ['ALL'],
            gateIds: [],
            isActive: true,
            createdById: superAdmin.id,
        },
        select: { id: true },
    });

    cachedEvergreenEventId = created.id;
    cachedAt = Date.now();
    logger.info('[CAMPUS-ENTRY] Evergreen event seeded', { eventId: created.id, name: eventName });
    return created.id;
}

// ── Login-id + password generation ─────────────────────────────
// Passwords are random-generated (10 alphanumerics, no ambiguous chars).
// Plaintext is stored in `passwordHint` for the outbound email only —
// admins can rotate this via the resend-credentials endpoint.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghjkmnpqrstuvwxyz';
function generatePassword(length = 10) {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i += 1) {
        out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
    }
    return out;
}

/**
 * Bulk-enroll students into the evergreen event.
 *
 * Accepts rows shaped like the existing events.routes participant
 * import so admins can reuse the same CSV/Excel templates. For each
 * row we:
 *   1. Upsert a Student (by email)
 *   2. Upsert an EventParticipant (by (eventId, email)) with a
 *      newly-generated password stored (plaintext) in passwordHint
 *      and hashed onto Student.passwordHash.
 *   3. Return the rows destined for the mailer.
 */
async function enrollParticipants(rows, { requestedById } = {}) {
    const eventId = await getOrCreateEvergreenEvent();
    if (!eventId) {
        throw new Error('Evergreen event not initialised — create a SUPER_ADMIN first.');
    }

    const summary = { total: rows.length, imported: 0, updated: 0, failed: 0, errors: [] };
    const mailerRows = [];

    // Batch bcrypt hashes to avoid CPU spikes on 10k imports.
    for (let i = 0; i < rows.length; i += 1) {
        const raw = rows[i] || {};
        const email = String(raw.email || '').trim().toLowerCase();
        const fullName = String(raw.fullName || raw.name || '').trim();
        const phone = String(raw.phone || raw.mobile || '').trim();
        const enrollmentNo = String(raw.enrollmentNo || raw.enrollment || '').trim() || null;
        const department = String(raw.department || raw.branch || '').trim() || 'GENERAL';
        const year = Number(raw.year) || 1;
        const section = String(raw.section || '').trim() || null;

        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            summary.failed += 1;
            summary.errors.push({ row: i + 1, reason: 'INVALID_EMAIL', email });
            continue;
        }
        if (!fullName) {
            summary.failed += 1;
            summary.errors.push({ row: i + 1, reason: 'MISSING_NAME', email });
            continue;
        }

        try {
            const password = generatePassword(10);
            // bcrypt cost 8 here (~15ms) instead of the default 10 (~90ms):
            // these credentials are auto-rotated on every re-import and on
            // any admin resend, so the effective work-factor a real
            // attacker would need to break is dominated by rotation
            // frequency, not the hash cost. Cost 8 keeps a 10k-row
            // bulk-import comfortably under 3 minutes without blowing
            // through the HTTP timeout.
            const passwordHash = await bcrypt.hash(password, 8);

            // Ensure enrollmentNo uniqueness. If we don't have one, mint a
            // stable "CE-<hash>" so the Student schema (unique enrollmentNo)
            // is satisfied without colliding with real ones.
            const derivedEnrollment = enrollmentNo
                || `CE-${crypto.createHash('sha1').update(email).digest('hex').slice(0, 10).toUpperCase()}`;

            const student = await prisma.student.upsert({
                where: { email },
                create: {
                    email,
                    fullName,
                    phone: phone || null,
                    enrollmentNo: derivedEnrollment,
                    department,
                    year,
                    section,
                    studentType: 'DAY_SCHOLAR',
                    userType: 'COLLEGE_STUDENT',
                    passwordHash,
                    isActive: true,
                },
                update: {
                    fullName,
                    phone: phone || undefined,
                    department,
                    year,
                    section: section || undefined,
                    passwordHash, // rotate to the new one so the emailed password works
                    isActive: true,
                },
                select: { id: true, enrollmentNo: true, fullName: true, department: true, email: true },
            });

            // Schema has (eventId, email) as an @@index but not @@unique,
            // so we can't use prisma.upsert directly on that compound.
            // Do a find-then-create/update.
            const existingParticipant = await prisma.eventParticipant.findFirst({
                where: { eventId, email: student.email },
                select: { id: true },
            });

            let participant;
            if (existingParticipant) {
                participant = await prisma.eventParticipant.update({
                    where: { id: existingParticipant.id },
                    data: {
                        studentId: student.id,
                        enrollmentNo: student.enrollmentNo,
                        fullName: student.fullName,
                        phone: phone || undefined,
                        passwordHint: password,
                        isActive: true,
                        credentialsIssuedAt: new Date(),
                        // Reset any prior entry-lock so re-imported students
                        // start fresh (admin can revoke again if needed).
                        entryUsedAt: null,
                        entryScanId: null,
                        entryScannedById: null,
                    },
                });
                summary.updated += 1;
            } else {
                participant = await prisma.eventParticipant.create({
                    data: {
                        eventId,
                        studentId: student.id,
                        enrollmentNo: student.enrollmentNo,
                        fullName: student.fullName,
                        email: student.email,
                        phone: phone || 'N/A',
                        loginId: student.email,
                        passwordHint: password,
                        isActive: true,
                        credentialsIssuedAt: new Date(),
                    },
                });
                summary.imported += 1;
            }

            mailerRows.push({
                participantId: participant.id,
                eventId,
                studentId: student.id,
                email: student.email,
                fullName: student.fullName,
                loginId: student.email,
                password,
                enrollmentNo: student.enrollmentNo,
            });
        } catch (err) {
            summary.failed += 1;
            summary.errors.push({ row: i + 1, reason: err?.message || 'UNKNOWN', email });
            logger.warn('[CAMPUS-ENTRY] enrollParticipants row failed', {
                row: i + 1,
                error: err?.message,
            });
        }
    }

    // Bump event.importedCount so the existing admin UI shows the count.
    if (summary.imported > 0) {
        await prisma.campusEvent.update({
            where: { id: eventId },
            data: { importedCount: { increment: summary.imported } },
        }).catch(() => {});
    }

    // Keep `total` reflecting the count of processed input rows so the
    // caller can render "X imported, Y updated, Z failed" cleanly.
    summary.total = rows.length;

    logger.info('[CAMPUS-ENTRY] enrollParticipants complete', { requestedById, ...summary });
    return { eventId, summary, mailerRows };
}

/**
 * Enrol EXISTING students (already in the Student collection) into
 * the evergreen event by studentId. Unlike enrollParticipants this
 * skips the Student upsert — the record already has enrolmentNo,
 * department, phone, etc. — and only:
 *   1. Rotates the student's password so the emailed one is authoritative
 *   2. Creates or updates the EventParticipant row
 *   3. Clears any prior entry lock so the student can enter fresh
 */
async function enrollExistingStudents(studentIds, { requestedById } = {}) {
    const eventId = await getOrCreateEvergreenEvent();
    if (!eventId) {
        throw new Error('Evergreen event not initialised — create a SUPER_ADMIN first.');
    }

    const uniqueIds = Array.from(new Set(
        (Array.isArray(studentIds) ? studentIds : [])
            .map((id) => String(id || '').trim())
            .filter(Boolean),
    ));

    const summary = { total: uniqueIds.length, imported: 0, updated: 0, failed: 0, errors: [] };
    const mailerRows = [];

    if (uniqueIds.length === 0) {
        return { eventId, summary, mailerRows };
    }

    // Batch-fetch the students so we don't hit Mongo one row at a time.
    const students = await prisma.student.findMany({
        where: { id: { in: uniqueIds } },
        select: {
            id: true,
            email: true,
            fullName: true,
            enrollmentNo: true,
            phone: true,
            department: true,
            year: true,
            section: true,
        },
    });
    const byId = new Map(students.map((s) => [s.id, s]));

    for (const studentId of uniqueIds) {
        const student = byId.get(studentId);
        if (!student) {
            summary.failed += 1;
            summary.errors.push({ studentId, reason: 'NOT_FOUND' });
            continue;
        }
        if (!student.email) {
            summary.failed += 1;
            summary.errors.push({ studentId, reason: 'MISSING_EMAIL' });
            continue;
        }

        try {
            const password = generatePassword(10);
            const passwordHash = await bcrypt.hash(password, 8);

            await prisma.student.update({
                where: { id: student.id },
                data: { passwordHash },
            });

            const existing = await prisma.eventParticipant.findFirst({
                where: { eventId, email: student.email },
                select: { id: true },
            });

            let participantId;
            if (existing) {
                await prisma.eventParticipant.update({
                    where: { id: existing.id },
                    data: {
                        studentId: student.id,
                        enrollmentNo: student.enrollmentNo,
                        fullName: student.fullName,
                        phone: student.phone || undefined,
                        passwordHint: password,
                        isActive: true,
                        credentialsIssuedAt: new Date(),
                        entryUsedAt: null,
                        entryScanId: null,
                        entryScannedById: null,
                    },
                });
                participantId = existing.id;
                summary.updated += 1;
            } else {
                const created = await prisma.eventParticipant.create({
                    data: {
                        eventId,
                        studentId: student.id,
                        enrollmentNo: student.enrollmentNo,
                        fullName: student.fullName,
                        email: student.email,
                        phone: student.phone || 'N/A',
                        loginId: student.email,
                        passwordHint: password,
                        isActive: true,
                        credentialsIssuedAt: new Date(),
                    },
                    select: { id: true },
                });
                participantId = created.id;
                summary.imported += 1;
            }

            mailerRows.push({
                participantId,
                eventId,
                studentId: student.id,
                email: student.email,
                fullName: student.fullName,
                loginId: student.email,
                password,
                enrollmentNo: student.enrollmentNo,
            });
        } catch (err) {
            summary.failed += 1;
            summary.errors.push({ studentId, reason: err?.message || 'UNKNOWN' });
            logger.warn('[CAMPUS-ENTRY] enrollExistingStudents row failed', {
                studentId,
                error: err?.message,
            });
        }
    }

    if (summary.imported > 0) {
        await prisma.campusEvent.update({
            where: { id: eventId },
            data: { importedCount: { increment: summary.imported } },
        }).catch(() => {});
    }

    logger.info('[CAMPUS-ENTRY] enrollExistingStudents complete', { requestedById, ...summary });
    return { eventId, summary, mailerRows };
}

/**
 * Mint a fresh rotating QR for the logged-in student. Fails if the
 * student is not enrolled or is currently entry-locked.
 */
async function mintQrForStudent(studentId) {
    const eventId = await getOrCreateEvergreenEvent();
    if (!eventId) {
        throw Object.assign(new Error('Campus entry not initialised'), { statusCode: 503, code: 'NOT_INITIALISED' });
    }

    const participant = await prisma.eventParticipant.findFirst({
        where: { eventId, studentId, isActive: true },
        select: {
            id: true,
            entryUsedAt: true,
            fullName: true,
            enrollmentNo: true,
        },
    });

    if (!participant) {
        throw Object.assign(new Error('You are not enrolled for campus entry'), {
            statusCode: 403,
            code: 'NOT_ENROLLED',
        });
    }

    const ttl = Number(config.CAMPUS_ENTRY_QR_TTL_SECONDS) || 20;
    const { token, expiresAt, ttlSeconds } = createParticipantQrToken({
        eventId,
        participantId: participant.id,
        ttlSeconds: ttl,
    });

    return {
        token,
        // Server-side truth for expiry — the client SHOULD refresh
        // before this, but MUST NOT display it (spec: no countdown).
        expiresAt,
        ttlSeconds,
        alreadyUsed: Boolean(participant.entryUsedAt),
        participant: {
            id: participant.id,
            fullName: participant.fullName,
            enrollmentNo: participant.enrollmentNo,
        },
    };
}

/**
 * Scanner-facing: verify a QR and, if valid+unused, consume the
 * single-entry lock atomically. Returns a discriminated union that
 * the scanner UI can render directly.
 */
async function verifyAndConsumeQr({ rawToken, scannedById, gateId = null, metadata = {} }) {
    if (!rawToken || typeof rawToken !== 'string') {
        return { ok: false, reason: 'MALFORMED', message: 'QR is missing or malformed.' };
    }

    const verified = verifyEventQrToken(rawToken.trim());
    if (!verified.valid || verified.format !== 'event_participant') {
        return {
            ok: false,
            reason: verified.reason || 'INVALID',
            message: verified.reason === 'EXPIRED'
                ? 'QR expired. Ask the student to refresh their screen.'
                : 'Invalid QR.',
        };
    }

    const { eventId, participantId } = verified.payload;

    // Sanity: token must belong to OUR evergreen event. Otherwise
    // someone re-used an old event-scoped token.
    const evergreenEventId = await getOrCreateEvergreenEvent();
    if (evergreenEventId && evergreenEventId !== eventId) {
        return { ok: false, reason: 'WRONG_EVENT', message: 'This QR is not for campus entry.' };
    }

    // Atomic single-entry consume:
    // Only rows where entryUsedAt IS NULL are eligible. If updateMany
    // reports count===0 the participant is already locked; otherwise
    // we won the race.
    const now = new Date();
    const claim = await prisma.eventParticipant.updateMany({
        where: { id: participantId, entryUsedAt: null, isActive: true },
        data: { entryUsedAt: now, entryScannedById: scannedById || null },
    });

    if (claim.count === 0) {
        // Either already used, deactivated, or never existed.
        const participant = await prisma.eventParticipant.findUnique({
            where: { id: participantId },
            select: {
                id: true,
                entryUsedAt: true,
                isActive: true,
                fullName: true,
                enrollmentNo: true,
                student: { select: { department: true, year: true, photoUrl: true } },
            },
        });
        if (!participant) {
            return { ok: false, reason: 'NOT_FOUND', message: 'Student not found.' };
        }
        if (!participant.isActive) {
            return { ok: false, reason: 'DEACTIVATED', message: 'This student is deactivated.' };
        }
        return {
            ok: false,
            reason: 'ALREADY_ENTERED',
            message: 'Entry recorded — this student has already entered and cannot enter again.',
            student: {
                fullName: participant.fullName,
                enrollmentNo: participant.enrollmentNo,
                department: participant.student?.department || null,
                year: participant.student?.year || null,
                photoUrl: participant.student?.photoUrl || null,
                usedAt: participant.entryUsedAt,
            },
        };
    }

    // Winning path — read back the participant with student for the
    // scanner UI. Also write a scan event for the admin feed.
    const participant = await prisma.eventParticipant.findUnique({
        where: { id: participantId },
        select: {
            id: true,
            fullName: true,
            enrollmentNo: true,
            email: true,
            entryUsedAt: true,
            studentId: true,
            student: {
                select: {
                    id: true,
                    fullName: true,
                    enrollmentNo: true,
                    email: true,
                    department: true,
                    year: true,
                    section: true,
                    photoUrl: true,
                    phone: true,
                    bloodGroup: true,
                    studentType: true,
                },
            },
        },
    });

    // Record a durable scan row (indexed for the admin feed).
    let scanRow = null;
    try {
        scanRow = await prisma.eventStayScan.create({
            data: {
                eventId,
                participantId: participant.id,
                studentId: participant.studentId || null,
                direction: 'ENTRY',
                scanMode: 'CAMPUS_ENTRY_QR',
                gateLabel: metadata?.gateLabel || null,
                result: 'VERIFIED',
                metadata: {
                    scannedById,
                    gateId,
                    ...metadata,
                },
            },
            select: { id: true, scannedAt: true },
        });

        // Backfill scan reference on the participant so revoke can audit it.
        await prisma.eventParticipant.update({
            where: { id: participant.id },
            data: { entryScanId: scanRow.id },
        }).catch(() => {});
    } catch (err) {
        logger.warn('[CAMPUS-ENTRY] Failed to record EventStayScan', { error: err.message });
    }

    return {
        ok: true,
        reason: 'ENTRY_RECORDED',
        message: 'Entry recorded.',
        participantId: participant.id,
        scanId: scanRow?.id || null,
        scannedAt: scanRow?.scannedAt || now,
        student: {
            fullName: participant.student?.fullName || participant.fullName,
            enrollmentNo: participant.student?.enrollmentNo || participant.enrollmentNo,
            email: participant.student?.email || participant.email,
            department: participant.student?.department || null,
            year: participant.student?.year || null,
            section: participant.student?.section || null,
            photoUrl: participant.student?.photoUrl || null,
            phone: participant.student?.phone || null,
            bloodGroup: participant.student?.bloodGroup || null,
            studentType: participant.student?.studentType || null,
        },
    };
}

/**
 * Admin-only: clear the entry lock so the student can enter again.
 * Records the revoke on the participant (count + reason + who) and
 * emits an audit log.
 */
async function revokeEntry({ participantId, revokedById, reason = null, req = null }) {
    const participant = await prisma.eventParticipant.findUnique({
        where: { id: participantId },
        select: {
            id: true,
            fullName: true,
            enrollmentNo: true,
            entryUsedAt: true,
            entryRevokeCount: true,
        },
    });
    if (!participant) {
        throw Object.assign(new Error('Participant not found'), { statusCode: 404, code: 'NOT_FOUND' });
    }

    if (!participant.entryUsedAt) {
        return {
            ok: true,
            reason: 'ALREADY_UNLOCKED',
            participantId,
        };
    }

    const updated = await prisma.eventParticipant.update({
        where: { id: participantId },
        data: {
            entryUsedAt: null,
            entryScanId: null,
            entryScannedById: null,
            entryRevokedAt: new Date(),
            entryRevokedById: revokedById || null,
            entryRevokeReason: reason ? String(reason).slice(0, 240) : null,
            entryRevokeCount: (participant.entryRevokeCount || 0) + 1,
        },
        select: { id: true, fullName: true, enrollmentNo: true, entryRevokedAt: true },
    });

    if (req) {
        await logAction(req, {
            action: 'CAMPUS_ENTRY_REVOKE',
            entity: 'EventParticipant',
            entityId: participantId,
            userId: revokedById,
            newValue: { reason, fullName: participant.fullName, enrollmentNo: participant.enrollmentNo },
        }).catch(() => {});
    }

    return { ok: true, reason: 'REVOKED', participant: updated };
}

/**
 * Read scans for the evergreen event, newest first. Paginated by
 * `cursor` (id) or `since` (ISO). Fast — leans on the existing
 * (eventId, scannedAt) compound index on EventStayScan.
 */
async function listScans({ limit = 50, cursor = null, since = null, search = null } = {}) {
    const eventId = await getOrCreateEvergreenEvent();
    if (!eventId) return { scans: [], nextCursor: null };

    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    const where = { eventId, scanMode: 'CAMPUS_ENTRY_QR' };
    if (since) {
        const d = new Date(since);
        if (!Number.isNaN(d.getTime())) where.scannedAt = { gte: d };
    }
    if (search) {
        const s = String(search).trim();
        if (s) {
            where.OR = [
                { participant: { is: { fullName: { contains: s, mode: 'insensitive' } } } },
                { participant: { is: { enrollmentNo: { contains: s, mode: 'insensitive' } } } },
                { participant: { is: { email: { contains: s, mode: 'insensitive' } } } },
            ];
        }
    }

    const rows = await prisma.eventStayScan.findMany({
        where,
        orderBy: [{ scannedAt: 'desc' }, { id: 'desc' }],
        take: safeLimit + 1,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: {
            id: true,
            scannedAt: true,
            gateLabel: true,
            result: true,
            metadata: true,
            participant: {
                select: {
                    id: true,
                    fullName: true,
                    enrollmentNo: true,
                    email: true,
                    entryUsedAt: true,
                },
            },
            student: {
                select: {
                    id: true,
                    department: true,
                    year: true,
                    section: true,
                    photoUrl: true,
                },
            },
        },
    });

    let nextCursor = null;
    if (rows.length > safeLimit) {
        const last = rows.pop();
        nextCursor = last.id;
    }
    return { scans: rows, nextCursor };
}

/**
 * List participants + their entry lock state. Powers the admin
 * "Campus Entry" management page — who's entered, who hasn't, who
 * has been revoked, and who never got their credentials email.
 */
async function listParticipants({ limit = 50, cursor = null, filter = null, search = null } = {}) {
    const eventId = await getOrCreateEvergreenEvent();
    if (!eventId) return { participants: [], nextCursor: null };

    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    const where = { eventId };
    if (filter === 'entered') where.entryUsedAt = { not: null };
    if (filter === 'not_entered') where.entryUsedAt = null;
    if (filter === 'revoked') where.entryRevokeCount = { gt: 0 };

    if (search) {
        const s = String(search).trim();
        if (s) {
            where.OR = [
                { fullName: { contains: s, mode: 'insensitive' } },
                { enrollmentNo: { contains: s, mode: 'insensitive' } },
                { email: { contains: s, mode: 'insensitive' } },
            ];
        }
    }

    const rows = await prisma.eventParticipant.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: safeLimit + 1,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: {
            id: true,
            fullName: true,
            enrollmentNo: true,
            email: true,
            phone: true,
            loginId: true,
            isActive: true,
            entryUsedAt: true,
            entryRevokedAt: true,
            entryRevokeCount: true,
            credentialsIssuedAt: true,
            student: {
                select: {
                    id: true,
                    department: true,
                    year: true,
                    section: true,
                    photoUrl: true,
                },
            },
        },
    });

    let nextCursor = null;
    if (rows.length > safeLimit) {
        const last = rows.pop();
        nextCursor = last.id;
    }
    return { participants: rows, nextCursor };
}

module.exports = {
    EVERGREEN_EVENT_TAG,
    getOrCreateEvergreenEvent,
    generatePassword,
    enrollParticipants,
    enrollExistingStudents,
    mintQrForStudent,
    verifyAndConsumeQr,
    revokeEntry,
    listScans,
    listParticipants,
};
