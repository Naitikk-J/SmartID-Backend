// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Access Policy Service
// Zone + Role + Time based access evaluation engine
// ═══════════════════════════════════════════════════════════════

const prisma = require('../config/database');
const logger = require('../config/logger');

/**
 * Evaluate whether a user should be granted access.
 *
 * Policy evaluation:
 *   1. Fetch all active policies matching user + zone + time
 *   2. Sort by priority (highest first)
 *   3. First DENY match → ACCESS DENIED
 *   4. First ALLOW match → ACCESS GRANTED
 *   5. No match → ACCESS DENIED (default deny)
 */
async function evaluateAccess(user, zone, eventType) {
    if (!zone) {
        // No zone configured on reader — allow (prototype default)
        return { allowed: true, reason: 'NO_ZONE_CONFIGURED', message: 'No zone restriction' };
    }

    const now = new Date();
    const dayOfWeek = now.getDay() || 7; // Convert Sunday from 0 to 7
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Fetch all active policies that could apply to this zone
    const policies = await prisma.accessPolicy.findMany({
        where: {
            isActive: true,
            zones: { has: zone },
        },
        orderBy: { priority: 'desc' },
    });

    if (policies.length === 0) {
        // No policies defined for this zone — allow by default (prototype)
        return { allowed: true, reason: 'NO_POLICY', message: 'No access policy for this zone' };
    }

    // Evaluate each policy in priority order
    for (const policy of policies) {
        if (!policyMatchesUser(policy, user)) continue;
        if (!policyMatchesTime(policy, dayOfWeek, currentTime)) continue;

        // This policy matches!
        if (policy.effect === 'DENY') {
            return {
                allowed: false,
                reason: 'ZONE_DENIED',
                message: policy.name || 'Access denied by policy',
                policyId: policy.id,
            };
        }

        if (policy.effect === 'ALLOW') {
            return {
                allowed: true,
                reason: 'POLICY_ALLOW',
                message: policy.name || 'Access granted by policy',
                policyId: policy.id,
            };
        }
    }

    // Default deny
    return {
        allowed: false,
        reason: 'NO_MATCHING_POLICY',
        message: 'No matching access policy — default deny',
    };
}

/**
 * Check if a policy applies to the given user.
 */
function policyMatchesUser(policy, user) {
    // If policy has no role/studentType restrictions, it applies to everyone
    const hasRoleFilter = policy.roles && policy.roles.length > 0;
    const hasTypeFilter = policy.studentTypes && policy.studentTypes.length > 0;

    if (!hasRoleFilter && !hasTypeFilter) return true;

    // Check roles (for admin/staff)
    if (hasRoleFilter && user.role && policy.roles.includes(user.role)) return true;

    // Check student types
    if (hasTypeFilter && user.studentType && policy.studentTypes.includes(user.studentType)) return true;

    // If policy has filters but user doesn't match any
    if (hasRoleFilter || hasTypeFilter) return false;

    return true;
}

/**
 * Check if current time falls within the policy's allowed window.
 */
function policyMatchesTime(policy, dayOfWeek, currentTime) {
    // Check day of week
    if (policy.allowedDays && policy.allowedDays.length > 0) {
        if (!policy.allowedDays.includes(dayOfWeek)) return false;
    }

    // Check time window
    if (policy.allowedStartTime && policy.allowedEndTime) {
        if (currentTime < policy.allowedStartTime || currentTime > policy.allowedEndTime) {
            return false;
        }
    }

    return true;
}

// ─── CRUD for Access Policies ───────────────────────────────────

async function createPolicy(data) {
    return prisma.accessPolicy.create({
        data: {
            name: data.name,
            description: data.description || null,
            roles: data.roles || [],
            studentTypes: data.studentTypes || [],
            zones: data.zones || [],
            readerIds: data.readerIds || [],
            allowedDays: data.allowedDays || [],
            allowedStartTime: data.allowedStartTime || null,
            allowedEndTime: data.allowedEndTime || null,
            credentialTypes: data.credentialTypes || [],
            priority: data.priority || 0,
            effect: data.effect || 'ALLOW',
            createdBy: data.createdBy || null,
        },
    });
}

async function updatePolicy(id, updates) {
    const policy = await prisma.accessPolicy.findUnique({ where: { id } });
    if (!policy) {
        const err = new Error('Policy not found');
        err.statusCode = 404;
        throw err;
    }

    return prisma.accessPolicy.update({
        where: { id },
        data: updates,
    });
}

async function deletePolicy(id) {
    const policy = await prisma.accessPolicy.findUnique({ where: { id } });
    if (!policy) {
        const err = new Error('Policy not found');
        err.statusCode = 404;
        throw err;
    }

    return prisma.accessPolicy.delete({ where: { id } });
}

async function listPolicies(filters = {}) {
    const where = {};
    if (filters.isActive !== undefined) where.isActive = filters.isActive;
    if (filters.zone) where.zones = { has: filters.zone };

    return prisma.accessPolicy.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { name: 'asc' }],
    });
}

async function getPolicyById(id) {
    return prisma.accessPolicy.findUnique({ where: { id } });
}

module.exports = {
    evaluateAccess,
    createPolicy,
    updatePolicy,
    deletePolicy,
    listPolicies,
    getPolicyById,
};
