// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Audit Logging Service
// ═══════════════════════════════════════════════════════════════

const prisma = require('../config/database');
const logger = require('../config/logger');

/**
 * Log an administrative or security action to the database.
 */
async function logAction(req, { action, entity, entityId = null, oldValue = null, newValue = null, userId = null }) {
    try {
        const actorId = userId || req.user?.id;
        const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

        if (!actorId) {
            logger.warn('AuditLog attempt without authenticated user', { action, entity });
            return null;
        }

        const log = await prisma.auditLog.create({
            data: {
                actorId,
                action,
                entity,
                entityId,
                oldValue: oldValue ? JSON.parse(JSON.stringify(oldValue)) : null,
                newValue: newValue ? JSON.parse(JSON.stringify(newValue)) : null,
                ipAddress,
            },
        });

        return log;
    } catch (err) {
        // We don't want audit logging failures to crash the main request
        logger.error('CRITICAL: AuditLog creation failed', { error: err.message, action, entity });
        return null;
    }
}

module.exports = { logAction };
