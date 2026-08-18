// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Device Authentication Middleware
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const prisma = require('../config/database');
const asyncHandler = require('./asyncHandler');
const { AppError } = require('./errorHandler');

/**
 * Authenticates ESP32 readers via HMAC-SHA256 signature.
 * Headers required:
 * - X-Reader-Id
 * - X-Timestamp
 * - X-Signature
 * 
 * Signature = HMAC-SHA256(deviceSecret, readerId + "|" + cardUid + "|" + timestamp + "|" + eventType)
 */
const authenticateDevice = asyncHandler(async (req, res, next) => {
    const readerId = req.headers['x-reader-id'];
    const timestamp = req.headers['x-timestamp'];
    const signature = req.headers['x-signature'];

    if (!readerId || !timestamp || !signature) {
        throw new AppError('Missing device authentication headers', 401, 'AUTH_FAILED');
    }

    // 1. Replay Protection: Check if timestamp is within ±30 seconds
    const reqTime = new Date(timestamp).getTime();
    const now = Date.now();
    if (isNaN(reqTime) || Math.abs(now - reqTime) > 30000) {
        throw new AppError('Request expired or invalid timestamp (replay protection)', 401, 'REPLAY_DETECTED');
    }

    // 2. Fetch Reader from DB
    const reader = await prisma.rfidReader.findUnique({
        where: { readerId }
    });

    if (!reader) {
        throw new AppError('Unknown reader ID', 401, 'UNKNOWN_READER');
    }

    if (reader.status !== 'ACTIVE') {
        throw new AppError(`Reader is ${reader.status}`, 403, 'READER_REVOKED');
    }

    // 3. Reconstruct HMAC
    const cardUid = req.body.cardUid || '';
    const eventType = req.body.eventType || '';
    const payloadToSign = `${readerId}|${cardUid}|${timestamp}|${eventType}`;

    // Get plain secret (prototype assumes it's stored plain, could be AES encrypted in prod)
    const deviceSecret = reader.deviceSecret;
    if (!deviceSecret) {
        throw new AppError('Reader missing device secret', 500, 'SERVER_ERROR');
    }

    const expectedSignature = crypto
        .createHmac('sha256', deviceSecret)
        .update(payloadToSign)
        .digest('hex');

    // Prevent timing attacks
    if (signature.length !== expectedSignature.length || !crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'))) {
        throw new AppError('Invalid signature', 401, 'INVALID_SIGNATURE');
    }

    // Attach device info to request
    req.device = {
        readerId: reader.readerId,
        readerDbId: reader.id,
        zone: reader.zone,
        location: reader.location
    };

    next();
});

module.exports = {
    authenticateDevice
};
