#!/usr/bin/env node
/**
 * MITS Smart ID — Campus Entry scan load test.
 *
 * Runs on your LOCAL backend (http://localhost:4000 by default) so
 * we don't fight production rate limits or burn Vercel quota. Real
 * MongoDB Atlas connection though, so DB latency numbers are honest.
 *
 * What it does, in order:
 *   1. Verifies the local backend is up.
 *   2. Ensures the evergreen campus event exists.
 *   3. Seeds N test participants (N = --participants, default 1000)
 *      tagged with __LOADTEST_TAG so we can clean them up cleanly.
 *   4. Mints one signed QR token per participant.
 *   5. Ensures a load-test SECURITY_GUARD admin user exists, gets
 *      a JWT for it (either logs in or mints directly).
 *   6. Fires REQUESTS requests at RPS req/sec against
 *      /api/v1/campus-entry/scan, cycling through the token pool.
 *   7. Reports p50 / p95 / p99, throughput, status breakdown.
 *   8. Deletes every scan row + participant we created.
 *
 * Usage:
 *   BASE_URL=http://localhost:4000 \
 *   node scripts/loadtest/campus-entry-scan.js \
 *       --participants=1000 --requests=10000 --rps=20
 *
 * Env you MUST have set (same .env the API uses):
 *   DATABASE_URL, JWT_SECRET
 * Optional:
 *   EVENT_QR_SIGNING_SECRET (falls back to JWT_SECRET)
 */

require('dotenv').config();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const prisma = require('../../src/config/database');
const {
    getOrCreateEvergreenEvent,
} = require('../../src/services/campusEntry.service');
const {
    createParticipantQrToken,
} = require('../../src/services/eventQrToken.service');

// ── Config from flags/env ─────────────────────────────────────
const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=')[1] : fallback;
};

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';
const PARTICIPANTS = Number(arg('participants', 1000));
const REQUESTS = Number(arg('requests', 10000));
const RPS = Number(arg('rps', 20));
const CONNECTIONS = Number(arg('connections', Math.max(RPS, 20)));
// Prefix on loginId that we use to identify seeded rows for cleanup.
// EventParticipant has no free-text "internalNotes" field, so we
// piggy-back on loginId (which is naturally unique per row).
const LOADTEST_LOGIN_PREFIX = 'LOADTEST_CE_';
const DURATION_S = Math.ceil(REQUESTS / RPS);

// ── Preflight ────────────────────────────────────────────────
async function ensureBackendUp() {
    const r = await fetch(`${BASE_URL}/health`).catch((e) => {
        throw new Error(`Backend not reachable at ${BASE_URL}: ${e.message}`);
    });
    if (!r.ok) throw new Error(`Backend health check failed: HTTP ${r.status}`);
}

// ── Seed test participants ───────────────────────────────────
async function seedParticipants(eventId, n) {
    console.log(`[seed] Creating ${n} test participants…`);
    const start = Date.now();

    // EventParticipant on this schema stores no password — real
    // credentials live on the linked Student model. Our load test
    // only exercises /scan (which just verifies the QR + flips
    // entryUsedAt), so no studentId / password data needed.
    // Unique batch tag so parallel runs don't collide on loginId.
    const batchTag = `${LOADTEST_LOGIN_PREFIX}${Date.now()}_`;

    const rows = Array.from({ length: n }, (_, i) => ({
        eventId,
        fullName: `LoadTest Student ${i + 1}`,
        email: `loadtest-${i + 1}-${Date.now()}@loadtest.mitsgwl.ac.in`,
        phone: '0000000000',
        loginId: `${batchTag}${i + 1}`,
        credentialsIssuedAt: new Date(),
        isActive: true,
    }));

    await prisma.eventParticipant.createMany({ data: rows });

    const created = await prisma.eventParticipant.findMany({
        where: { eventId, loginId: { startsWith: batchTag } },
        select: { id: true },
    });

    if (created.length !== n) {
        throw new Error(`Expected ${n} participants, got ${created.length}`);
    }

    console.log(`[seed] ${n} participants ready in ${Date.now() - start}ms`);
    return created.map((c) => c.id);
}

// ── Ensure a scanner admin user exists + mint its JWT ───────
async function ensureScannerAdmin() {
    const email = 'loadtest-scanner@mitsgwl.ac.in';
    const existing = await prisma.adminUser.findUnique({ where: { email } });
    let user;
    if (existing) {
        user = existing;
    } else {
        user = await prisma.adminUser.create({
            data: {
                email,
                passwordHash: await bcrypt.hash('loadtest-scanner-pass', 4),
                name: 'LoadTest Scanner',
                role: 'SECURITY_GUARD',
                isActive: true,
            },
        });
        console.log(`[auth] Created SECURITY_GUARD user ${email}`);
    }

    // Mint the same JWT shape the real /auth/login would.
    const token = jwt.sign(
        {
            id: user.id,
            email: user.email,
            role: user.role,
            department: null,
            module: user.module,
            userType: 'ADMIN',
            appAccess: 'FULL',
        },
        process.env.JWT_SECRET,
        { expiresIn: '2h' },
    );
    return { userId: user.id, token };
}

// ── Mint QR tokens for every participant ─────────────────────
async function mintTokens(eventId, participantIds) {
    console.log(`[qr] Minting ${participantIds.length} QR tokens…`);
    // TTL well beyond DURATION_S so no token expires mid-run.
    const ttl = Math.max(60, DURATION_S + 60);
    return participantIds.map((pid) =>
        createParticipantQrToken({ eventId, participantId: pid, ttlSeconds: ttl }).token,
    );
}

// ── Autocannon run ───────────────────────────────────────────
async function runLoad(tokens, jwtToken) {
    const autocannon = require('autocannon');

    let cursor = 0;
    const url = `${BASE_URL}/api/v1/campus-entry/scan`;

    const instance = autocannon({
        url,
        method: 'POST',
        connections: CONNECTIONS,
        overallRate: RPS,        // strict rps target
        amount: REQUESTS,        // stop after N requests
        duration: DURATION_S + 30, // safety cap
        timeout: 15,
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${jwtToken}`,
        },
        // Rotate a fresh token from the pool for each request.
        setupClient: (client) => {
            client.setBody(''); // placeholder, replaced per-request
            client.on('response', () => { /* noop; keeps hook alive */ });
        },
        requests: [
            {
                setupRequest: (req) => {
                    const token = tokens[cursor % tokens.length];
                    cursor += 1;
                    return {
                        ...req,
                        body: JSON.stringify({ qrToken: token, gateLabel: 'LOADTEST' }),
                    };
                },
            },
        ],
    });

    autocannon.track(instance, { renderProgressBar: true });

    return new Promise((resolve, reject) => {
        instance.on('done', resolve);
        instance.on('error', reject);
    });
}

// ── Cleanup ──────────────────────────────────────────────────
async function cleanup(eventId) {
    console.log('[cleanup] Removing load-test rows…');
    const start = Date.now();

    const parts = await prisma.eventParticipant.findMany({
        where: { eventId, loginId: { startsWith: LOADTEST_LOGIN_PREFIX } },
        select: { id: true },
    });
    const ids = parts.map((p) => p.id);
    if (ids.length === 0) {
        console.log('[cleanup] Nothing to delete.');
        return;
    }

    // Delete scans that reference these participants first (FK-ish).
    const delScans = await prisma.eventStayScan.deleteMany({
        where: { eventId, participantId: { in: ids } },
    });
    const delParts = await prisma.eventParticipant.deleteMany({
        where: { id: { in: ids } },
    });

    console.log(`[cleanup] Deleted ${delParts.count} participants + ${delScans.count} scan rows in ${Date.now() - start}ms`);
}

// ── Main ─────────────────────────────────────────────────────
(async () => {
    const started = Date.now();
    console.log('┌─ Campus Entry scan load test ─────────────────────────');
    console.log(`│ target      : ${BASE_URL}/api/v1/campus-entry/scan`);
    console.log(`│ participants: ${PARTICIPANTS}`);
    console.log(`│ requests    : ${REQUESTS}`);
    console.log(`│ rps         : ${RPS}`);
    console.log(`│ duration    : ~${DURATION_S}s`);
    console.log('└──────────────────────────────────────────────────────');

    try {
        await ensureBackendUp();
        const eventId = await getOrCreateEvergreenEvent();
        if (!eventId) throw new Error('No evergreen campus event found. Boot the API first.');

        // Idempotency: nuke prior load-test rows before seeding.
        await cleanup(eventId);

        const ids = await seedParticipants(eventId, PARTICIPANTS);
        const tokens = await mintTokens(eventId, ids);
        const { token: jwtToken } = await ensureScannerAdmin();

        console.log('[load] Starting autocannon…');
        const result = await runLoad(tokens, jwtToken);

        console.log('\n┌─ Results ─────────────────────────────────────────────');
        console.log(`│ requests fired : ${result.requests.total}`);
        console.log(`│ throughput     : ${result.requests.average.toFixed(1)} rps avg`);
        console.log(`│ latency p50    : ${result.latency.p50} ms`);
        console.log(`│ latency p95    : ${result.latency.p97_5} ms (p97.5)`);
        console.log(`│ latency p99    : ${result.latency.p99} ms`);
        console.log(`│ latency max    : ${result.latency.max} ms`);
        console.log(`│ 2xx            : ${result['2xx']}`);
        console.log(`│ non-2xx        : ${result.non2xx}`);
        console.log(`│ errors         : ${result.errors}`);
        console.log(`│ timeouts       : ${result.timeouts}`);
        console.log('└──────────────────────────────────────────────────────');
    } catch (err) {
        console.error('[fatal]', err);
        process.exitCode = 1;
    } finally {
        try {
            const eventId = await getOrCreateEvergreenEvent();
            if (eventId) await cleanup(eventId);
        } catch (e) { console.error('[cleanup-error]', e.message); }
        await prisma.$disconnect().catch(() => { });
        console.log(`\nTotal elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
})();
