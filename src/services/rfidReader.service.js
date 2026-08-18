// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — RFID Reader Service
// Reader management, heartbeat processing, offline detection
// ═══════════════════════════════════════════════════════════════

const prisma = require('../config/database');
const logger = require('../config/logger');
const config = require('../config/env');

/**
 * Register a new RFID reader.
 */
async function registerReader(readerConfig, registeredBy) {
    // Check for duplicate reader ID
    const existing = await prisma.rfidReader.findUnique({
        where: { readerId: readerConfig.readerId },
    });
    if (existing) {
        const err = new Error(`Reader with ID "${readerConfig.readerId}" already exists`);
        err.statusCode = 409;
        err.code = 'READER_EXISTS';
        throw err;
    }

    const reader = await prisma.rfidReader.create({
        data: {
            readerId: readerConfig.readerId,
            deviceName: readerConfig.deviceName,
            location: readerConfig.location || null,
            zone: readerConfig.zone || null,
            deviceSecret: readerConfig.deviceSecret,
            firmwareVersion: readerConfig.firmwareVersion || null,
            capabilities: readerConfig.capabilities || ['MIFARE_CLASSIC'],
            registeredBy,
        },
    });

    logger.info('RFID reader registered', {
        readerId: reader.readerId,
        registeredBy,
    });

    // Return reader but strip secret
    const { deviceSecret, ...safeReader } = reader;
    return safeReader;
}

/**
 * Update reader configuration.
 */
async function updateReader(id, updates) {
    const reader = await prisma.rfidReader.findUnique({ where: { id } });
    if (!reader) {
        const err = new Error('Reader not found');
        err.statusCode = 404;
        throw err;
    }

    const data = {};
    if (updates.deviceName !== undefined) data.deviceName = updates.deviceName;
    if (updates.location !== undefined) data.location = updates.location;
    if (updates.zone !== undefined) data.zone = updates.zone;
    if (updates.capabilities !== undefined) data.capabilities = updates.capabilities;
    if (updates.status !== undefined) data.status = updates.status;
    if (updates.deviceSecret !== undefined) data.deviceSecret = updates.deviceSecret;

    const updated = await prisma.rfidReader.update({
        where: { id },
        data,
    });

    const { deviceSecret, ...safeReader } = updated;
    return safeReader;
}

/**
 * Revoke a reader (permanently disable it).
 */
async function revokeReader(id) {
    const reader = await prisma.rfidReader.findUnique({ where: { id } });
    if (!reader) {
        const err = new Error('Reader not found');
        err.statusCode = 404;
        throw err;
    }

    const updated = await prisma.rfidReader.update({
        where: { id },
        data: {
            status: 'REVOKED',
            isOnline: false,
        },
    });

    logger.warn('RFID reader revoked', { readerId: reader.readerId, dbId: id });
    const { deviceSecret, ...safeReader } = updated;
    return safeReader;
}

/**
 * Process heartbeat from an ESP32 reader.
 */
async function processHeartbeat(readerId, heartbeatData) {
    const reader = await prisma.rfidReader.findUnique({
        where: { readerId },
    });
    if (!reader) {
        const err = new Error('Reader not found');
        err.statusCode = 404;
        throw err;
    }

    // Update reader status
    const wasOnline = reader.isOnline;
    await prisma.rfidReader.update({
        where: { readerId },
        data: {
            isOnline: true,
            lastHeartbeat: new Date(),
            ipAddress: heartbeatData.ipAddress || reader.ipAddress,
            firmwareVersion: heartbeatData.firmwareVersion || reader.firmwareVersion,
        },
    });

    // Record heartbeat
    await prisma.deviceHeartbeat.create({
        data: {
            readerId: reader.id,
            isOnline: true,
            ipAddress: heartbeatData.ipAddress || null,
            firmwareVersion: heartbeatData.firmwareVersion || null,
            freeHeapBytes: heartbeatData.freeHeapBytes || null,
            wifiRssi: heartbeatData.wifiRssi || null,
            uptime: heartbeatData.uptime || null,
            queuedEvents: heartbeatData.queuedEvents || null,
        },
    });

    const statusChanged = !wasOnline;
    if (statusChanged) {
        logger.info('RFID reader came online', { readerId });
    }

    return {
        serverTime: new Date().toISOString(),
        readerStatus: reader.status,
        commands: [],
        statusChanged,
    };
}

/**
 * Get reader details by database ID.
 */
async function getReaderById(id) {
    const reader = await prisma.rfidReader.findUnique({
        where: { id },
        include: {
            heartbeats: {
                orderBy: { timestamp: 'desc' },
                take: 20,
            },
            _count: {
                select: { transactions: true },
            },
        },
    });

    if (!reader) return null;

    const { deviceSecret, ...safeReader } = reader;
    return safeReader;
}

/**
 * List all readers with optional filters.
 */
async function listReaders(filters = {}) {
    const where = {};
    if (filters.status) where.status = filters.status;
    if (filters.zone) where.zone = filters.zone;
    if (filters.isOnline !== undefined) where.isOnline = filters.isOnline;

    const readers = await prisma.rfidReader.findMany({
        where,
        select: {
            id: true,
            readerId: true,
            deviceName: true,
            location: true,
            zone: true,
            status: true,
            firmwareVersion: true,
            ipAddress: true,
            lastHeartbeat: true,
            isOnline: true,
            capabilities: true,
            createdAt: true,
            updatedAt: true,
            registeredBy: true,
            _count: { select: { transactions: true } },
        },
        orderBy: [{ isOnline: 'desc' }, { deviceName: 'asc' }],
    });

    return readers;
}

/**
 * Get all readers with their current online/offline status.
 */
async function getReaderStatuses() {
    return prisma.rfidReader.findMany({
        where: { status: { not: 'DECOMMISSIONED' } },
        select: {
            id: true,
            readerId: true,
            deviceName: true,
            location: true,
            zone: true,
            status: true,
            isOnline: true,
            lastHeartbeat: true,
        },
        orderBy: { deviceName: 'asc' },
    });
}

/**
 * Mark readers as offline if no heartbeat received within grace period.
 * Called by scheduler cron job.
 */
async function markOfflineReaders() {
    const graceMinutes = config.RFID_OFFLINE_GRACE_MINUTES || 5;
    const cutoff = new Date(Date.now() - graceMinutes * 60 * 1000);

    const staleReaders = await prisma.rfidReader.findMany({
        where: {
            isOnline: true,
            OR: [
                { lastHeartbeat: { lt: cutoff } },
                { lastHeartbeat: null },
            ],
        },
    });

    if (staleReaders.length === 0) return [];

    await prisma.rfidReader.updateMany({
        where: {
            id: { in: staleReaders.map((r) => r.id) },
        },
        data: { isOnline: false },
    });

    const offlineIds = staleReaders.map((r) => r.readerId);
    logger.warn('Marked readers as offline', { readerIds: offlineIds, graceMinutes });

    return offlineIds;
}

module.exports = {
    registerReader,
    updateReader,
    revokeReader,
    processHeartbeat,
    getReaderById,
    listReaders,
    getReaderStatuses,
    markOfflineReaders,
};
