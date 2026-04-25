// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — AES-256-GCM Crypto Service
// Encrypt/decrypt QR code payloads
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config/env');

const ALGORITHM = 'aes-256-gcm';
const DEFAULT_AES_KEY_HEX = '0000000000000000000000000000000000000000000000000000000000000000';

function resolveKey() {
    const candidate = typeof config.AES_KEY === 'string' && config.AES_KEY.trim()
        ? config.AES_KEY.trim()
        : null;

    if (!candidate || !/^[0-9a-fA-F]{64}$/.test(candidate)) {
        if (config.NODE_ENV === 'production') {
            throw new Error(
                'FATAL: AES_KEY is missing or invalid in production. '
                + 'All QR encryption would use an insecure default key. '
                + 'Set a valid 64-character hex AES_KEY environment variable.'
            );
        }
        console.warn('⚠️ WARNING: Using insecure default AES key. Set AES_KEY env var for production.');
        return Buffer.from(DEFAULT_AES_KEY_HEX, 'hex');
    }

    return Buffer.from(candidate, 'hex');
}

const KEY = resolveKey(); // 32 bytes = 256 bits
const IV_LENGTH = Number.isInteger(config.AES_IV_LENGTH) && config.AES_IV_LENGTH > 0
    ? config.AES_IV_LENGTH
    : 16; // 16 bytes
const AUTH_TAG_LENGTH = 16; // bytes

/**
 * Encrypt a payload object into a base64url token.
 * Format: [IV (16 bytes)][AuthTag (16 bytes)][Ciphertext]
 * @param {object} payload - JSON-serializable object (e.g. { enrollmentNo, cardId })
 * @returns {string} base64url-encoded encrypted token
 */
function encryptToken(payload) {
    if (payload === undefined || payload === null) {
        throw new Error('Payload cannot be undefined or null');
    }
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
    const jsonStr = JSON.stringify(payload);
    const encrypted = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const combined = Buffer.concat([iv, authTag, encrypted]);
    return combined.toString('base64url');
}

/**
 * Decrypt a base64url token back to a payload object.
 * IMPORTANT: Does NOT catch errors — let them propagate for tamper detection.
 * @param {string} token - base64url-encoded encrypted token
 * @returns {object} decrypted payload
 */
function decryptToken(token) {
    if (!token || typeof token !== 'string') {
        throw new Error('Token must be a non-empty string');
    }
    const buf = Buffer.from(token, 'base64url');
    if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
        throw new Error('Token too short to be valid');
    }
    const iv = buf.subarray(0, IV_LENGTH);
    const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
}

/**
 * Generate a unique card UID in format CRD-XXXX (uppercase hex).
 * @returns {string} card UID
 */
function generateCardUid() {
    return 'CRD-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

/**
 * Hash a plain text password using bcrypt.
 * @param {string} password - plain text password
 * @returns {Promise<string>} hashed password
 */
async function hashPassword(password) {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
}

/**
 * Verify a plain text password against a hash.
 * @param {string} password - plain text password
 * @param {string} hash - salt + hashed password
 * @returns {Promise<boolean>} true if match
 */
async function verifyPassword(password, hash) {
    if (!password || !hash) return false;
    return bcrypt.compare(password, hash);
}

module.exports = { encryptToken, decryptToken, generateCardUid, hashPassword, verifyPassword };
