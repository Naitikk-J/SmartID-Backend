// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — RFID Service
// Core RFID business logic: credential management + card verification
// ═══════════════════════════════════════════════════════════════

const prisma = require('../config/database');
const logger = require('../config/logger');

const DUPLICATE_TAP_WINDOW_MS = 5000; // 5 seconds

// ─── Credential Management ─────────────────────────────────────

/**
 * Assign an RFID card to a student.
 */
async function assignCredential(userId, cardUid, assignedBy, options = {}) {
    // Check if card UID is already assigned
    const existingCard = await prisma.rfidCredential.findUnique({
        where: { cardUid },
    });
    if (existingCard) {
        const err = new Error('Card UID is already assigned to another user');
        err.statusCode = 409;
        err.code = 'CARD_ALREADY_ASSIGNED';
        throw err;
    }

    // Check if user exists
    const user = await prisma.student.findUnique({
        where: { id: userId },
        select: { id: true, fullName: true, enrollmentNo: true },
    });
    if (!user) {
        const err = new Error('Student not found');
        err.statusCode = 404;
        err.code = 'USER_NOT_FOUND';
        throw err;
    }

    const credential = await prisma.rfidCredential.create({
        data: {
            userId,
            cardUid: cardUid.toUpperCase(),
            label: options.label || null,
            expiresAt: options.expiresAt ? new Date(options.expiresAt) : null,
            assignedBy,
            credentialType: options.credentialType || 'MIFARE_CLASSIC',
        },
        include: {
            user: {
                select: { fullName: true, enrollmentNo: true, department: true },
            },
        },
    });

    logger.info('RFID credential assigned', {
        credentialId: credential.id,
        userId,
        cardUid: credential.cardUid,
        assignedBy,
    });

    return credential;
}

/**
 * Revoke an RFID credential.
 */
async function revokeCredential(credentialId, revokedBy, reason) {
    const credential = await prisma.rfidCredential.findUnique({
        where: { id: credentialId },
    });
    if (!credential) {
        const err = new Error('Credential not found');
        err.statusCode = 404;
        throw err;
    }
    if (credential.status === 'REVOKED') {
        const err = new Error('Credential is already revoked');
        err.statusCode = 400;
        throw err;
    }

    const updated = await prisma.rfidCredential.update({
        where: { id: credentialId },
        data: {
            status: 'REVOKED',
            revokedAt: new Date(),
            revokedBy,
            revokeReason: reason || null,
        },
        include: {
            user: {
                select: { fullName: true, enrollmentNo: true },
            },
        },
    });

    logger.info('RFID credential revoked', {
        credentialId,
        revokedBy,
        reason,
    });

    return updated;
}

/**
 * Suspend an RFID credential (temporary).
 */
async function suspendCredential(credentialId) {
    const credential = await prisma.rfidCredential.findUnique({
        where: { id: credentialId },
    });
    if (!credential) {
        const err = new Error('Credential not found');
        err.statusCode = 404;
        throw err;
    }
    if (credential.status !== 'ACTIVE') {
        const err = new Error(`Cannot suspend credential with status: ${credential.status}`);
        err.statusCode = 400;
        throw err;
    }

    return prisma.rfidCredential.update({
        where: { id: credentialId },
        data: { status: 'SUSPENDED' },
        include: {
            user: { select: { fullName: true, enrollmentNo: true } },
        },
    });
}

/**
 * Re-activate a suspended RFID credential.
 */
async function activateCredential(credentialId) {
    const credential = await prisma.rfidCredential.findUnique({
        where: { id: credentialId },
    });
    if (!credential) {
        const err = new Error('Credential not found');
        err.statusCode = 404;
        throw err;
    }
    if (credential.status !== 'SUSPENDED') {
        const err = new Error(`Cannot activate credential with status: ${credential.status}`);
        err.statusCode = 400;
        throw err;
    }

    return prisma.rfidCredential.update({
        where: { id: credentialId },
        data: { status: 'ACTIVE' },
        include: {
            user: { select: { fullName: true, enrollmentNo: true } },
        },
    });
}

/**
 * Replace an RFID credential — revoke old, assign new.
 */
async function replaceCredential(oldCredentialId, newCardUid, assignedBy, reason) {
    const old = await prisma.rfidCredential.findUnique({
        where: { id: oldCredentialId },
    });
    if (!old) {
        const err = new Error('Old credential not found');
        err.statusCode = 404;
        throw err;
    }

    // Revoke old
    await prisma.rfidCredential.update({
        where: { id: oldCredentialId },
        data: {
            status: 'REVOKED',
            revokedAt: new Date(),
            revokedBy: assignedBy,
            revokeReason: reason || 'Replaced with new card',
        },
    });

    // Assign new
    const newCredential = await assignCredential(old.userId, newCardUid, assignedBy, {
        label: old.label,
        expiresAt: old.expiresAt,
        credentialType: old.credentialType,
    });

    logger.info('RFID credential replaced', {
        oldCredentialId,
        newCredentialId: newCredential.id,
        userId: old.userId,
    });

    return newCredential;
}

// ─── Card Verification (Critical Path) ─────────────────────────

/**
 * Verify RFID card access — called by ESP32 readers via POST /rfid/verify.
 * Returns { accessGranted, user, reason, transaction }.
 */
async function verifyAccess(readerDbId, readerId, cardUid, eventType, deviceTimestamp, zone) {
    const startTime = Date.now();
    const normalizedUid = cardUid.toUpperCase();

    // 1. Duplicate tap prevention
    const recentTxn = await prisma.rfidTransaction.findFirst({
        where: {
            cardUid: normalizedUid,
            readerId: readerDbId,
            serverTimestamp: { gte: new Date(Date.now() - DUPLICATE_TAP_WINDOW_MS) },
        },
        orderBy: { serverTimestamp: 'desc' },
    });

    if (recentTxn) {
        const txn = await createTransaction({
            readerId: readerDbId,
            cardUid: normalizedUid,
            eventType,
            accessResult: 'DENIED',
            denialReason: 'DUPLICATE_TAP',
            deviceTimestamp,
            processingMs: Date.now() - startTime,
        });

        return {
            accessGranted: false,
            reason: 'DUPLICATE_TAP',
            message: 'Duplicate tap detected — please wait',
            eventId: txn.id,
        };
    }

    // 2. Look up credential by card UID
    const credential = await prisma.rfidCredential.findUnique({
        where: { cardUid: normalizedUid },
        include: {
            user: {
                select: {
                    id: true,
                    fullName: true,
                    enrollmentNo: true,
                    department: true,
                    studentType: true,
                    photoUrl: true,
                    isActive: true,
                },
            },
        },
    });

    // 3. Unknown card
    if (!credential) {
        const txn = await createTransaction({
            readerId: readerDbId,
            cardUid: normalizedUid,
            eventType,
            accessResult: 'DENIED',
            denialReason: 'UNKNOWN_CARD',
            deviceTimestamp,
            processingMs: Date.now() - startTime,
        });

        return {
            accessGranted: false,
            reason: 'UNKNOWN_CARD',
            message: 'Card not recognized',
            cardUid: normalizedUid,
            eventId: txn.id,
        };
    }

    // 4. Check credential status
    if (credential.status === 'REVOKED') {
        const txn = await createTransaction({
            readerId: readerDbId,
            credentialId: credential.id,
            userId: credential.userId,
            cardUid: normalizedUid,
            eventType,
            accessResult: 'DENIED',
            denialReason: 'CARD_REVOKED',
            deviceTimestamp,
            processingMs: Date.now() - startTime,
        });

        return {
            accessGranted: false,
            reason: 'CARD_REVOKED',
            message: 'Card has been revoked',
            eventId: txn.id,
        };
    }

    if (credential.status === 'SUSPENDED') {
        const txn = await createTransaction({
            readerId: readerDbId,
            credentialId: credential.id,
            userId: credential.userId,
            cardUid: normalizedUid,
            eventType,
            accessResult: 'DENIED',
            denialReason: 'CARD_SUSPENDED',
            deviceTimestamp,
            processingMs: Date.now() - startTime,
        });

        return {
            accessGranted: false,
            reason: 'CARD_SUSPENDED',
            message: 'Card is temporarily suspended',
            eventId: txn.id,
        };
    }

    if (credential.status === 'LOST') {
        const txn = await createTransaction({
            readerId: readerDbId,
            credentialId: credential.id,
            userId: credential.userId,
            cardUid: normalizedUid,
            eventType,
            accessResult: 'DENIED',
            denialReason: 'CARD_LOST',
            deviceTimestamp,
            processingMs: Date.now() - startTime,
        });

        return {
            accessGranted: false,
            reason: 'CARD_LOST',
            message: 'Card reported as lost',
            eventId: txn.id,
        };
    }

    // 5. Check card expiry
    if (credential.expiresAt && new Date(credential.expiresAt) < new Date()) {
        // Auto-update status to EXPIRED
        await prisma.rfidCredential.update({
            where: { id: credential.id },
            data: { status: 'EXPIRED' },
        });

        const txn = await createTransaction({
            readerId: readerDbId,
            credentialId: credential.id,
            userId: credential.userId,
            cardUid: normalizedUid,
            eventType,
            accessResult: 'DENIED',
            denialReason: 'CARD_EXPIRED',
            deviceTimestamp,
            processingMs: Date.now() - startTime,
        });

        return {
            accessGranted: false,
            reason: 'CARD_EXPIRED',
            message: 'Card has expired',
            eventId: txn.id,
        };
    }

    // 6. Check user is active
    const user = credential.user;
    if (!user || !user.isActive) {
        const txn = await createTransaction({
            readerId: readerDbId,
            credentialId: credential.id,
            userId: credential.userId,
            cardUid: normalizedUid,
            eventType,
            accessResult: 'DENIED',
            denialReason: 'USER_INACTIVE',
            deviceTimestamp,
            processingMs: Date.now() - startTime,
        });

        return {
            accessGranted: false,
            reason: 'USER_INACTIVE',
            message: 'Student account is inactive',
            eventId: txn.id,
        };
    }

    // 7. Access policy evaluation (if policies exist)
    try {
        const accessPolicy = require('./accessPolicy.service');
        const policyResult = await accessPolicy.evaluateAccess(user, zone, eventType);
        if (!policyResult.allowed) {
            const txn = await createTransaction({
                readerId: readerDbId,
                credentialId: credential.id,
                userId: credential.userId,
                cardUid: normalizedUid,
                eventType,
                accessResult: 'DENIED',
                denialReason: policyResult.reason,
                deviceTimestamp,
                processingMs: Date.now() - startTime,
            });

            return {
                accessGranted: false,
                reason: policyResult.reason,
                message: policyResult.message || 'Access denied by policy',
                eventId: txn.id,
            };
        }
    } catch (policyErr) {
        // If access policy service fails, allow access (prototype behavior)
        logger.warn('Access policy evaluation failed — allowing access (prototype)', {
            error: policyErr.message,
        });
    }

    // 8. Access GRANTED — create transaction + update credential stats
    const [txn] = await Promise.all([
        createTransaction({
            readerId: readerDbId,
            credentialId: credential.id,
            userId: credential.userId,
            cardUid: normalizedUid,
            eventType,
            accessResult: 'GRANTED',
            deviceTimestamp,
            processingMs: Date.now() - startTime,
        }),
        prisma.rfidCredential.update({
            where: { id: credential.id },
            data: {
                lastUsedAt: new Date(),
                tapCount: { increment: 1 },
            },
        }),
    ]);

    return {
        accessGranted: true,
        user: {
            id: user.id,
            name: user.fullName,
            enrollmentNo: user.enrollmentNo,
            role: 'STUDENT',
            department: user.department,
            photoUrl: user.photoUrl,
        },
        eventId: txn.id,
        message: 'Access granted',
    };
}

// ─── Helpers ────────────────────────────────────────────────────

async function createTransaction(data) {
    return prisma.rfidTransaction.create({
        data: {
            readerId: data.readerId,
            credentialId: data.credentialId || null,
            userId: data.userId || null,
            cardUid: data.cardUid,
            eventType: data.eventType,
            accessResult: data.accessResult,
            denialReason: data.denialReason || null,
            deviceTimestamp: data.deviceTimestamp ? new Date(data.deviceTimestamp) : new Date(),
            processingMs: data.processingMs || null,
            isOfflineSync: data.isOfflineSync || false,
            metadata: data.metadata || null,
        },
    });
}

/**
 * Bulk sync offline events from ESP32.
 */
async function syncOfflineEvents(readerDbId, readerId, events, zone) {
    const results = [];

    for (const event of events) {
        try {
            const result = await verifyAccess(
                readerDbId,
                readerId,
                event.cardUid,
                event.eventType,
                event.timestamp,
                zone,
            );
            results.push({ cardUid: event.cardUid, ...result, isOfflineSync: true });
        } catch (err) {
            results.push({
                cardUid: event.cardUid,
                error: err.message,
                isOfflineSync: true,
            });
        }
    }

    return results;
}

// ─── Query Helpers ──────────────────────────────────────────────

async function getCredentialById(id) {
    return prisma.rfidCredential.findUnique({
        where: { id },
        include: {
            user: {
                select: {
                    fullName: true,
                    enrollmentNo: true,
                    department: true,
                    year: true,
                    studentType: true,
                    photoUrl: true,
                },
            },
        },
    });
}

async function getUserCredentials(userId) {
    return prisma.rfidCredential.findMany({
        where: { userId },
        orderBy: { issuedAt: 'desc' },
    });
}

async function listCredentials(filters = {}, page = 1, limit = 20) {
    const where = {};
    if (filters.status) where.status = filters.status;
    if (filters.userId) where.userId = filters.userId;
    if (filters.search) {
        where.OR = [
            { cardUid: { contains: filters.search, mode: 'insensitive' } },
            { user: { fullName: { contains: filters.search, mode: 'insensitive' } } },
            { user: { enrollmentNo: { contains: filters.search, mode: 'insensitive' } } },
        ];
    }

    const [total, data] = await Promise.all([
        prisma.rfidCredential.count({ where }),
        prisma.rfidCredential.findMany({
            where,
            include: {
                user: {
                    select: {
                        fullName: true,
                        enrollmentNo: true,
                        department: true,
                        studentType: true,
                    },
                },
            },
            orderBy: { issuedAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
        }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

async function listTransactions(filters = {}, page = 1, limit = 20) {
    const where = {};
    if (filters.readerId) where.readerId = filters.readerId;
    if (filters.userId) where.userId = filters.userId;
    if (filters.cardUid) where.cardUid = filters.cardUid.toUpperCase();
    if (filters.eventType) where.eventType = filters.eventType;
    if (filters.accessResult) where.accessResult = filters.accessResult;
    if (filters.startDate || filters.endDate) {
        where.serverTimestamp = {};
        if (filters.startDate) where.serverTimestamp.gte = new Date(filters.startDate);
        if (filters.endDate) where.serverTimestamp.lte = new Date(filters.endDate);
    }

    const [total, data] = await Promise.all([
        prisma.rfidTransaction.count({ where }),
        prisma.rfidTransaction.findMany({
            where,
            include: {
                reader: { select: { readerId: true, deviceName: true, zone: true } },
                credential: { select: { cardUid: true, status: true } },
                user: { select: { fullName: true, enrollmentNo: true, department: true } },
            },
            orderBy: { serverTimestamp: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
        }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

async function getTransactionById(id) {
    return prisma.rfidTransaction.findUnique({
        where: { id },
        include: {
            reader: { select: { readerId: true, deviceName: true, zone: true, location: true } },
            credential: { select: { cardUid: true, status: true, label: true } },
            user: {
                select: {
                    fullName: true,
                    enrollmentNo: true,
                    department: true,
                    photoUrl: true,
                },
            },
        },
    });
}

// ─── Stats ──────────────────────────────────────────────────────

async function getStats() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [
        totalCards,
        activeCards,
        revokedCards,
        expiredCards,
        suspendedCards,
        activeReaders,
        offlineReaders,
        todayTransactions,
        todayGranted,
        todayDenied,
    ] = await Promise.all([
        prisma.rfidCredential.count(),
        prisma.rfidCredential.count({ where: { status: 'ACTIVE' } }),
        prisma.rfidCredential.count({ where: { status: 'REVOKED' } }),
        prisma.rfidCredential.count({ where: { status: 'EXPIRED' } }),
        prisma.rfidCredential.count({ where: { status: 'SUSPENDED' } }),
        prisma.rfidReader.count({ where: { isOnline: true, status: 'ACTIVE' } }),
        prisma.rfidReader.count({ where: { isOnline: false, status: 'ACTIVE' } }),
        prisma.rfidTransaction.count({ where: { serverTimestamp: { gte: todayStart } } }),
        prisma.rfidTransaction.count({ where: { serverTimestamp: { gte: todayStart }, accessResult: 'GRANTED' } }),
        prisma.rfidTransaction.count({ where: { serverTimestamp: { gte: todayStart }, accessResult: 'DENIED' } }),
    ]);

    return {
        cards: { total: totalCards, active: activeCards, revoked: revokedCards, expired: expiredCards, suspended: suspendedCards },
        readers: { active: activeReaders, offline: offlineReaders },
        today: { transactions: todayTransactions, granted: todayGranted, denied: todayDenied },
    };
}

module.exports = {
    assignCredential,
    revokeCredential,
    suspendCredential,
    activateCredential,
    replaceCredential,
    verifyAccess,
    syncOfflineEvents,
    getCredentialById,
    getUserCredentials,
    listCredentials,
    listTransactions,
    getTransactionById,
    getStats,
};
