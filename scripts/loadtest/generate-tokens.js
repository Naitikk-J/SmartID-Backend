#!/usr/bin/env node
/* eslint-disable no-console */
// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — k6 token-pool generator
//
// Builds a JSON file of AES-encrypted QR tokens by pulling a sample
// of ACTIVE cards out of the configured Prisma database. Each token
// is generated with the EXACT same `encryptToken` path the mobile
// app uses, so the resulting payloads decrypt cleanly server-side
// and exercise the real scan-verify pipeline.
//
// Usage:
//   AES_KEY=<64-hex>  DATABASE_URL=mongodb://...staging  \
//     node scripts/loadtest/generate-tokens.js \
//       --count=2000 \
//       --gate=<gate-id> \
//       --gps-lat=26.234 --gps-lng=78.181 \
//       --out=scripts/loadtest/tokens.json
//
// ⚠️  NEVER run this against the production database. The script
//     refuses to start if `DATABASE_URL` looks like a prod URI
//     (matches `prod` or `production` substring) unless you set
//     `I_KNOW_WHAT_IM_DOING=1`.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const args = {};
    for (const arg of argv.slice(2)) {
        const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
        if (!m) continue;
        args[m[1]] = m[2] ?? true;
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv);

    const count = Math.min(50_000, Math.max(1, Number(args.count) || 500));
    const gateId = args.gate ? String(args.gate) : null;
    const gpsLat = Number(args['gps-lat'] ?? 26.234);
    const gpsLng = Number(args['gps-lng'] ?? 78.181);
    const out = args.out || 'scripts/loadtest/tokens.json';
    const scanType = String(args['scan-type'] || 'GATE_ENTRY');

    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set.');
        process.exit(2);
    }

    // Production-DB guard — operator must opt in explicitly.
    if (
        /prod|production/i.test(process.env.DATABASE_URL || '')
        && !process.env.I_KNOW_WHAT_IM_DOING
    ) {
        console.error(
            'Refusing to run against what looks like a production DATABASE_URL.\n'
            + 'Set I_KNOW_WHAT_IM_DOING=1 only if you absolutely mean it.',
        );
        process.exit(3);
    }

    if (!process.env.AES_KEY || !/^[0-9a-fA-F]{64}$/.test(process.env.AES_KEY)) {
        console.error('AES_KEY must be a 64-character hex string matching the API server.');
        process.exit(2);
    }

    const prisma = require('../../src/config/database');
    const { encryptToken } = require('../../src/services/crypto.service');

    console.log(`Sampling up to ${count} active cards…`);

    // Pull a random-ish sample of active cards. Prisma+Mongo doesn't
    // support `$sample` directly, but cards is small enough for
    // skip/take with a random skip to cover the table.
    const totalActive = await prisma.card.count({ where: { status: 'ACTIVE' } });
    if (totalActive === 0) {
        console.error('No ACTIVE cards found. Seed staging data before generating tokens.');
        process.exit(4);
    }

    const skip = totalActive > count
        ? Math.floor(Math.random() * (totalActive - count))
        : 0;

    const cards = await prisma.card.findMany({
        where: { status: 'ACTIVE' },
        select: {
            id: true,
            qrToken: true,
            student: { select: { id: true, enrollmentNo: true } },
        },
        skip,
        take: count,
    });

    if (cards.length === 0) {
        console.error('Card query returned 0 rows. Aborting.');
        process.exit(5);
    }

    console.log(`Building ${cards.length} encrypted payloads…`);

    const tokens = [];
    for (const card of cards) {
        // STATIC payload — same shape the mobile app emits. The server
        // accepts cards with stored `qrToken` matches OR re-encrypts on
        // each scan, so this payload exercises both paths.
        const payload = {
            enrollmentNo: card.student?.enrollmentNo || null,
            cardId: card.id,
            ts: Math.floor(Date.now() / 1000),
        };
        let token;
        try {
            token = encryptToken(payload);
        } catch (err) {
            console.warn(`Skipping card ${card.id}: ${err.message}`);
            continue;
        }
        tokens.push({
            token,
            gpsLat,
            gpsLng,
            location: gateId ? null : 'MAIN_GATE',
            gateId: gateId || undefined,
            scanType,
        });
    }

    const outPath = path.resolve(out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(tokens, null, 2));
    console.log(`Wrote ${tokens.length} tokens to ${outPath}`);

    await prisma.$disconnect?.();
}

main().catch((err) => {
    console.error('Token generation failed:', err);
    process.exit(1);
});
