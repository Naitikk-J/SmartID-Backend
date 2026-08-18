// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — RFID Real-time Event Feed
//
// Dual-transport emitter (Socket.IO + SSE) for RFID events.
// Follows the same pattern as scanFeed.socket.js.
// ═══════════════════════════════════════════════════════════════

const logger = require('../config/logger');
const sseHub = require('./sseHub');

/**
 * Emit an RFID transaction event to the dashboard.
 */
function emitRfidEvent(transaction, user, reader) {
    const payload = {
        id: transaction.id?.toString(),
        time: transaction.serverTimestamp || new Date(),
        studentName: user?.fullName || user?.name || 'Unknown',
        enrollmentNo: user?.enrollmentNo || 'N/A',
        department: user?.department || 'N/A',
        eventType: transaction.eventType,
        accessResult: transaction.accessResult,
        denialReason: transaction.denialReason || null,
        credentialType: 'RFID',
        readerId: reader?.readerId || transaction.readerId,
        readerName: reader?.deviceName || 'Unknown Reader',
        zone: reader?.zone || null,
        cardUid: transaction.cardUid,
    };

    // Socket.IO path
    try {
        const { io } = require('../server');
        if (io) {
            io.to('rfid-dashboard').emit('RFID_EVENT', payload);
            io.to('dashboard').emit('RFID_EVENT', payload);
        }
    } catch (err) {
        logger.warn('Failed to emit RFID event over Socket.IO:', err?.message || 'Unknown error');
    }

    // SSE path
    try {
        sseHub.broadcast('RFID_EVENT', payload);
    } catch (err) {
        logger.warn('Failed to emit RFID event over SSE:', err?.message || 'Unknown error');
    }
}

/**
 * Emit reader status change (online/offline).
 */
function emitReaderStatusChange(reader) {
    const payload = {
        readerId: reader.readerId,
        deviceName: reader.deviceName,
        location: reader.location,
        zone: reader.zone,
        isOnline: reader.isOnline,
        status: reader.status,
        lastHeartbeat: reader.lastHeartbeat,
        time: new Date(),
    };

    try {
        const { io } = require('../server');
        if (io) {
            io.to('rfid-dashboard').emit('READER_STATUS_CHANGE', payload);
        }
    } catch (err) {
        logger.warn('Failed to emit reader status change (Socket.IO):', err.message);
    }

    try {
        sseHub.broadcast('READER_STATUS_CHANGE', payload);
    } catch (err) {
        logger.warn('Failed to emit reader status change (SSE):', err.message);
    }
}

/**
 * Emit RFID security alert.
 */
function emitRfidAlert(alert) {
    const payload = {
        type: alert.type, // 'MULTIPLE_DENIED', 'UNKNOWN_CARD_FLOOD', 'READER_OFFLINE'
        message: alert.message,
        readerId: alert.readerId || null,
        details: alert.details || null,
        time: new Date(),
    };

    try {
        const { io } = require('../server');
        if (io) {
            io.to('rfid-dashboard').emit('RFID_ALERT', payload);
        }
    } catch (err) {
        logger.warn('Failed to emit RFID alert (Socket.IO):', err.message);
    }

    try {
        sseHub.broadcast('RFID_ALERT', payload);
    } catch (err) {
        logger.warn('Failed to emit RFID alert (SSE):', err.message);
    }
}

module.exports = { emitRfidEvent, emitReaderStatusChange, emitRfidAlert };
