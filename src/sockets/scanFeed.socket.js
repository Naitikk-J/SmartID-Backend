// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Real-time scan feed
//
// Dual-transport emitter:
//   - Socket.IO room 'dashboard' for sticky-session deployments
//   - SSE hub for serverless / no-WebSocket environments
//
// Both transports get the same payload, so admin UIs can pick
// whichever is available without divergent code paths.
// ═══════════════════════════════════════════════════════════════

const logger = require('../config/logger');
const sseHub = require('./sseHub');

const BADGE_MAP = {
    VERIFIED: 'GREEN',
    GRANTED: 'GREEN',
    RFID_VERIFIED: 'GREEN',
    FAKE: 'RED',
    LOST: 'AMBER',
    INACTIVE: 'GREY',
    DENIED: 'RED',
    RFID_DENIED: 'RED',
    RFID_UNKNOWN_CARD: 'RED',
    RFID_REVOKED: 'AMBER',
    RFID_EXPIRED: 'AMBER',
    GPS_FAIL: 'RED',
    LIMIT_HIT: 'RED',
    EXIT_LIMIT_REACHED: 'RED',
    DUPLICATE: 'AMBER',
    DUPLICATE_TAP: 'AMBER',
    TIME_EXPIRED: 'RED',
    ALREADY_VOTED: 'AMBER',
    ALREADY_ENTERED: 'AMBER',
    ALREADY_EXITED: 'AMBER',
    REENTRY_COOLDOWN_ACTIVE: 'AMBER',
    STAY_COOLDOWN_ACTIVE: 'AMBER',
    SCAN_COOLDOWN_ACTIVE: 'AMBER',
    COOLDOWN_ACTIVE: 'AMBER',
    ANTI_PASSBACK: 'RED',
};

/**
 * Emit a scan event to the dashboard room.
 */
function emitScanEvent({ scanEvent, student, scanType, result }) {
    const payload = {
        id: scanEvent.id?.toString(),
        time: scanEvent.scannedAt || new Date(),
        studentName: student?.fullName || 'Unknown',
        enrollmentNo: student?.enrollmentNo || 'N/A',
        department: student?.department || 'N/A',
        scanType,
        result,
        badge: BADGE_MAP[result] || 'GREY',
        gateId: scanEvent.gateId,
        gateName: scanEvent.gateName || null,
    };

    // Socket.IO path (real WebSocket dashboard clients).
    try {
        const { io } = require('../server');
        if (io) io.to('dashboard').emit('SCAN_EVENT', payload);
    } catch (err) {
        logger.warn('Failed to emit scan event over Socket.IO:', err?.message || 'Unknown error');
    }

    // SSE path (long-poll / serverless-friendly subscribers).
    try {
        sseHub.broadcast('SCAN_EVENT', payload);
    } catch (err) {
        logger.warn('Failed to emit scan event over SSE:', err?.message || 'Unknown error');
    }
}

/**
 * Emit exit rule change to dashboard (triggers device cache refresh).
 */
function emitExitRuleChange(updatedRules) {
    try {
        const { io } = require('../server');
        if (io) io.to('dashboard').emit('EXIT_RULES_UPDATED', updatedRules);
    } catch (err) {
        logger.warn('Failed to emit exit rule change (Socket.IO):', err.message);
    }
    try { sseHub.broadcast('EXIT_RULES_UPDATED', updatedRules); } catch (err) {
        logger.warn('Failed to emit exit rule change (SSE):', err.message);
    }
}

/**
 * Emit attendance session update.
 */
function emitSessionUpdate(sessionData) {
    try {
        const { io } = require('../server');
        if (io) io.to('dashboard').emit('SESSION_UPDATE', sessionData);
    } catch (err) {
        logger.warn('Failed to emit session update (Socket.IO):', err.message);
    }
    try { sseHub.broadcast('SESSION_UPDATE', sessionData); } catch (err) {
        logger.warn('Failed to emit session update (SSE):', err.message);
    }
}

module.exports = { emitScanEvent, emitExitRuleChange, emitSessionUpdate };
