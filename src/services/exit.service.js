// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Exit Service
// Exit token bucket + campus event overrides
// ═══════════════════════════════════════════════════════════════

const prisma = require('../config/database');
const logger = require('../config/logger');
const cache = require('./cache.service');

const EXIT_RULE_TTL_MS = 30000;     // Rules change rarely.
const ACTIVE_EVENT_TTL_MS = 10000;  // Re-poll every 10s — events come and go.

// ── Cached lookups ──────────────────────────────────────────

async function getCachedActiveEvent(studentType, gateId, now) {
    // Bucket the cache by 10s window so different scans share the result
    // but we still re-check soon enough to honour event start/end.
    const bucket = Math.floor(now.getTime() / ACTIVE_EVENT_TTL_MS);
    const key = `exit:activeEvent:${bucket}:${gateId || '_'}:${studentType}`;
    return cache.getOrLoad(
        key,
        () => prisma.campusEvent.findFirst({
            where: {
                isActive: true,
                startTime: { lte: now },
                endTime: { gte: now },
                ...(gateId && { gateIds: { has: gateId } }),
                OR: [
                    { appliesTo: { has: 'ALL' } },
                    { appliesTo: { has: studentType } },
                ],
            },
            orderBy: { startTime: 'desc' },
        }),
        { ttlMs: ACTIVE_EVENT_TTL_MS, l1TtlMs: ACTIVE_EVENT_TTL_MS },
    );
}

async function getCachedExitRule(studentType, dayOfWeek) {
    const key = `exit:rule:${studentType}:${dayOfWeek}`;
    return cache.getOrLoad(
        key,
        () => prisma.exitRule.findUnique({
            where: { studentType_dayOfWeek: { studentType, dayOfWeek } },
        }),
        { ttlMs: EXIT_RULE_TTL_MS },
    );
}

/**
 * Check if a student is allowed to exit campus.
 * Priority: active campus event > exit rules > default allow.
 */
async function checkExitAllowed(student, gateId) {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const today = new Date(todayStr);
    // Day of week: 1=Mon ... 7=Sun
    const jsDay = now.getDay(); // 0=Sun
    const dayOfWeek = jsDay === 0 ? 7 : jsDay;

    // Day Scholars have no exit limits
    if (student.studentType === 'DAY_SCHOLAR') {
        return { allowed: true, mode: 'BYPASS', used: 0, max: -1, reason: 'Day Scholar bypass' };
    }

    // Step 1: Check for active campus event (cached)
    const activeEvent = await getCachedActiveEvent(student.studentType, gateId, now);

    // Step 2: If event found, apply event mode
    if (activeEvent) {
        if (activeEvent.exitMode === 'UNLIMITED') {
            return { allowed: true, mode: 'UNLIMITED', used: 0, max: -1, reason: `Event: ${activeEvent.name}` };
        }

        // Count exits today for this student
        const exitsToday = await countExitsToday(student.id, today);

        if (activeEvent.exitMode === 'SINGLE') {
            return {
                allowed: exitsToday < 1,
                mode: 'SINGLE',
                used: exitsToday,
                max: 1,
                reason: exitsToday >= 1 ? 'Single exit already used (event mode)' : `Event: ${activeEvent.name}`,
            };
        }

        if (activeEvent.exitMode === 'CUSTOM') {
            const max = activeEvent.customMax || 1;
            return {
                allowed: exitsToday < max,
                mode: 'CUSTOM',
                used: exitsToday,
                max,
                reason: exitsToday >= max ? 'Exit limit reached (event mode)' : `Event: ${activeEvent.name}`,
            };
        }
    }

    // Step 3: No active event — use exit rules (cached)
    const rule = await getCachedExitRule(student.studentType, dayOfWeek);

    if (!rule) {
        return { allowed: true, mode: 'NO_RULE', used: 0, max: -1, reason: 'No exit rule defined' };
    }

    if (rule.maxExits === -1) {
        return { allowed: true, mode: 'UNLIMITED', used: 0, max: -1, reason: 'Unlimited exits today' };
    }

    // Step 4: Count exits today
    const exitsToday = await countExitsToday(student.id, today);

    return {
        allowed: exitsToday < rule.maxExits,
        mode: 'RULE',
        used: exitsToday,
        max: rule.maxExits,
        reason: exitsToday >= rule.maxExits
            ? `Exit limit reached: ${exitsToday}/${rule.maxExits}`
            : `Exits: ${exitsToday}/${rule.maxExits}`,
    };
}

/**
 * Count EXIT events for a student today.
 */
async function countExitsToday(studentId, today) {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    return prisma.exitEvent.count({
        where: {
            studentId,
            direction: 'EXIT',
            eventDate: {
                gte: today,
                lt: tomorrow,
            },
        },
    });
}
async function countEntriesToday(studentId, today) {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    return prisma.exitEvent.count({
        where: {
            studentId,
            direction: 'ENTRY',
            eventDate: {
                gte: today,
                lt: tomorrow,
            },
        },
    });
}

/**
 * Record an exit/entry event.
 */
async function recordExitEvent(studentId, gateId, direction = 'EXIT', actorId = null) {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    let finalGateId = gateId;

    // Validate gateId - if it's not a valid ObjectId, try to find by name 
    const isObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);

    if (gateId && !isObjectId(gateId)) {
        logger.info(`Invalid gateId format: ${gateId}. Attempting to find by name.`);
        const gate = await prisma.gate.findFirst({
            where: {
                OR: [
                    { name: { equals: gateId, mode: 'insensitive' } },
                    { name: 'Main Gate' }
                ]
            }
        });
        finalGateId = gate?.id || null;
    }

    const event = await prisma.exitEvent.create({
        data: {
            student: { connect: { id: studentId } },
            direction,
            eventDate: new Date(todayStr),
            eventTime: now,
            ...(finalGateId && { gate: { connect: { id: finalGateId } } }),
            ...(actorId && { overrideBy: { connect: { id: actorId } } }),
        },
    });

    // Create Audit Log for traceability
    if (actorId) {
        await prisma.auditLog.create({
            data: {
                actorId: actorId,
                action: direction === 'EXIT' ? 'CAMPUS_EXIT' : 'CAMPUS_ENTRY',
                entity: 'Student',
                entityId: studentId,
                newValue: {
                    gateId: finalGateId,
                    direction,
                    eventId: event.id
                }
            }
        });
    }

    return event;
}

/**
 * Upsert an exit rule and write to audit log.
 */
async function updateExitRule(studentType, dayOfWeek, maxExits, adminId) {
    const existing = await prisma.exitRule.findUnique({
        where: { studentType_dayOfWeek: { studentType, dayOfWeek } },
    });

    const rule = await prisma.exitRule.upsert({
        where: { studentType_dayOfWeek: { studentType, dayOfWeek } },
        update: { maxExits, updatedById: adminId },
        create: { studentType, dayOfWeek, maxExits, updatedById: adminId },
    });

    // Invalidate caches so the next scan sees the new rule.
    await cache.invalidatePrefix('exit:rule:');
    await cache.invalidatePrefix('exit:activeEvent:');

    // Audit log
    await prisma.auditLog.create({
        data: {
            actorId: adminId,
            action: 'UPDATE_EXIT_RULE',
            entity: 'ExitRule',
            entityId: rule.id,
            oldValue: existing ? { maxExits: existing.maxExits } : null,
            newValue: { maxExits },
        },
    });

    return rule;
}

/**
 * Get all exit rules as a grid: { [studentType]: { [dayOfWeek]: maxExits } }
 */
async function getExitRulesGrid() {
    const rules = await prisma.exitRule.findMany({
        orderBy: [{ studentType: 'asc' }, { dayOfWeek: 'asc' }],
    });

    const grid = {};
    for (const rule of rules) {
        if (!grid[rule.studentType]) {
            grid[rule.studentType] = {};
        }
        grid[rule.studentType][rule.dayOfWeek] = rule.maxExits;
    }
    return grid;
}

/**
 * Get exit history with filters.
 */
async function getExitHistory({ studentId, gateId, startDate, endDate, page = 1, limit = 50 }) {
    const where = {};
    if (studentId) where.studentId = studentId;
    if (gateId) where.gateId = gateId;
    if (startDate || endDate) {
        where.eventDate = {};
        if (startDate) where.eventDate.gte = new Date(startDate);
        if (endDate) where.eventDate.lte = new Date(endDate);
    }

    const [events, total] = await Promise.all([
        prisma.exitEvent.findMany({
            where,
            include: { student: { select: { fullName: true, enrollmentNo: true, studentType: true } }, gate: true },
            orderBy: { eventTime: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.exitEvent.count({ where }),
    ]);

    return { events, total, page, limit, pages: Math.ceil(total / limit) };
}

module.exports = {
    checkExitAllowed,
    recordExitEvent,
    updateExitRule,
    getExitRulesGrid,
    getExitHistory,
    countExitsToday,
    countEntriesToday,
};
