// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Socket.io Scan Feed
// Real-time event emitter for dashboard
// ═══════════════════════════════════════════════════════════════

const logger = require('../config/logger');

const BADGE_MAP = {
    VERIFIED: 'GREEN',
    FAKE: 'RED',
    LOST: 'AMBER',
    INACTIVE: 'GREY',
    DENIED: 'RED',
    GPS_FAIL: 'RED',
    LIMIT_HIT: 'RED',
    DUPLICATE: 'AMBER',
    TIME_EXPIRED: 'RED',
    ALREADY_VOTED: 'AMBER',
};

/**
 * Emit a scan event to the dashboard room.
 */
function emitScanEvent({ scanEvent, student, scanType, result }) {
    try {
        // Lazy-load io to avoid circular dependency
        const { io } = require('../server');
        if (!io) return;

        io.to('dashboard').emit('SCAN_EVENT', {
            id: scanEvent.id?.toString(),
            time: scanEvent.scannedAt || new Date(),
            studentName: student?.fullName || 'Unknown',
            enrollmentNo: student?.enrollmentNo || 'N/A',
            department: student?.department || 'N/A',
            scanType,
            result,
            badge: BADGE_MAP[result] || 'GREY',
            gateId: scanEvent.gateId,
        });
    } catch (err) {
        logger.warn('Failed to emit scan event:', err?.message || 'Unknown error');
    }
}

/**
 * Emit exit rule change to dashboard (triggers device cache refresh).
 */
function emitExitRuleChange(updatedRules) {
    try {
        const { io } = require('../server');
        if (!io) return;
        io.to('dashboard').emit('EXIT_RULES_UPDATED', updatedRules);
    } catch (err) {
        logger.warn('Failed to emit exit rule change:', err.message);
    }
}

/**
 * Emit attendance session update.
 */
function emitSessionUpdate(sessionData) {
    try {
        const { io } = require('../server');
        if (!io) return;
        io.to('dashboard').emit('SESSION_UPDATE', sessionData);
    } catch (err) {
        logger.warn('Failed to emit session update:', err.message);
    }
}

module.exports = { emitScanEvent, emitExitRuleChange, emitSessionUpdate };
