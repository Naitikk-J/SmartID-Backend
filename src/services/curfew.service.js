// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Curfew Service
//
// Uses the shared Prisma singleton (was leaking a fresh PrismaClient
// per import — that path also blocked graceful shutdown).
// Cached lookups protect the hot scan path; mutations invalidate.
// ═══════════════════════════════════════════════════════════════

const prisma = require('../config/database');
const cache = require('./cache.service');

const CACHE_KEY_ALL = 'curfew:rules:all';
const CACHE_TTL_MS = 30000; // 30s — curfew rules change rarely.

const DEFAULT_CURFEW_RULES = [
    { studentType: 'DAY_SCHOLAR', startTime: '21:00', endTime: '06:00', isActive: true },
    { studentType: 'HOSTELLER_BOYS', startTime: '21:00', endTime: '06:00', isActive: true },
    { studentType: 'HOSTELLER_GIRLS', startTime: '21:00', endTime: '06:00', isActive: true },
];

async function getCurfewRules() {
    return cache.getOrLoad(
        CACHE_KEY_ALL,
        async () => {
            let rules = await prisma.curfewRule.findMany({
                orderBy: { updatedAt: 'desc' },
            });

            // Bootstrap defaults once so the admin UI always has editable rows.
            if (!rules.length) {
                await Promise.all(
                    DEFAULT_CURFEW_RULES.map((rule) => prisma.curfewRule.create({ data: rule })),
                );
                rules = await prisma.curfewRule.findMany({
                    orderBy: { updatedAt: 'desc' },
                });
            }
            return rules;
        },
        { ttlMs: CACHE_TTL_MS },
    );
}

async function getCurfewRuleById(id) {
    return prisma.curfewRule.findUnique({ where: { id } });
}

async function createCurfewRule(data) {
    const created = await prisma.curfewRule.create({ data });
    await cache.invalidate(CACHE_KEY_ALL);
    return created;
}

async function updateCurfewRule(id, data) {
    const updated = await prisma.curfewRule.update({ where: { id }, data });
    await cache.invalidate(CACHE_KEY_ALL);
    return updated;
}

async function deleteCurfewRule(id) {
    const deleted = await prisma.curfewRule.delete({ where: { id } });
    await cache.invalidate(CACHE_KEY_ALL);
    return deleted;
}

module.exports = {
    getCurfewRules,
    getCurfewRuleById,
    createCurfewRule,
    updateCurfewRule,
    deleteCurfewRule,
};
