const crypto = require('crypto');
const config = require('../config/env');

const EVENT_STAY_QR_VERSION = 'eq1';
const EVENT_MESS_QR_VERSION = 'mq1';
// Per-participant rotating campus-entry QR (student displays, guard scans).
// Distinct version prefix so verifyEventQrToken can dispatch cleanly and
// old event-stay clients never accidentally accept a participant token.
const EVENT_PARTICIPANT_QR_VERSION = 'ep1';

function base64UrlEncode(input) {
    return Buffer.from(input)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function base64UrlDecode(input) {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
    return Buffer.from(padded, 'base64').toString('utf8');
}

function getSigningSecret() {
    return String(process.env.EVENT_QR_SIGNING_SECRET || process.env.ACCESS_QR_SIGNING_SECRET || config.JWT_SECRET || '');
}

function signPayload(payloadSegment) {
    const secret = getSigningSecret();
    return base64UrlEncode(
        crypto.createHmac('sha256', secret).update(payloadSegment).digest(),
    );
}

function createEventStayQrToken({ eventId, eventName, createdById, ttlSeconds = 90 }) {
    const nowSec = Math.floor(Date.now() / 1000);
    const expSec = nowSec + Math.min(180, Math.max(20, Number(ttlSeconds) || 90));

    // Compact payload: omit nulls and shorten nonce to minimize QR code grid density
    const payload = {
        eid: String(eventId),
        exp: expSec,
        n: crypto.randomBytes(3).toString('hex'),
        ...(eventName ? { enm: String(eventName) } : {}),
        ...(createdById ? { cb: String(createdById) } : {}),
    };

    const payloadSegment = base64UrlEncode(JSON.stringify(payload));
    const signatureSegment = signPayload(payloadSegment).slice(0, 12);

    return {
        token: `${EVENT_STAY_QR_VERSION}.${payloadSegment}.${signatureSegment}`,
        expiresAt: new Date(expSec * 1000),
    };
}

function createEventMessQrToken({ eventId, mealNumber = null, mealLabel = null, eventEndsAt }) {
    const nowSec = Math.floor(Date.now() / 1000);
    const defaultTtlSec = 60 * 60 * 24 * 30;
    let expSec = nowSec + defaultTtlSec;

    if (eventEndsAt instanceof Date && Number.isFinite(eventEndsAt.getTime())) {
        const eventEndSec = Math.floor(eventEndsAt.getTime() / 1000);
        if (eventEndSec > nowSec + 60) {
            expSec = eventEndSec;
        }
    }

    // Compact payload
    const payload = {
        eid: String(eventId),
        exp: expSec,
        ...(Number.isInteger(Number(mealNumber)) && Number(mealNumber) > 0 ? { meal: Number(mealNumber) } : {}),
        ...(mealLabel ? { mlb: String(mealLabel) } : {}),
    };

    const payloadSegment = base64UrlEncode(JSON.stringify(payload));
    const signatureSegment = signPayload(payloadSegment).slice(0, 12);

    return {
        token: `${EVENT_MESS_QR_VERSION}.${payloadSegment}.${signatureSegment}`,
        expiresAt: new Date(expSec * 1000),
    };
}

function verifySignedToken(versionPrefix, token) {
    if (typeof token !== 'string') {
        return { format: 'unknown', valid: false, reason: 'MALFORMED' };
    }

    const trimmed = token.trim();
    if (!trimmed.startsWith(`${versionPrefix}.`)) {
        return { format: 'unknown', valid: false, reason: 'UNSUPPORTED_FORMAT' };
    }

    const segments = trimmed.split('.');
    if (segments.length !== 3) {
        return { format: 'signed', valid: false, reason: 'MALFORMED' };
    }

    const [, payloadSegment, signatureSegment] = segments;
    const fullExpectedSignature = signPayload(payloadSegment);
    const expectedSignature = fullExpectedSignature.slice(0, signatureSegment.length);

    const providedBuffer = Buffer.from(signatureSegment);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (providedBuffer.length !== expectedBuffer.length
        || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
        return { format: 'signed', valid: false, reason: 'INVALID_SIGNATURE' };
    }

    let payload;
    try {
        payload = JSON.parse(base64UrlDecode(payloadSegment));
    } catch {
        return { format: 'signed', valid: false, reason: 'MALFORMED' };
    }

    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
        return { format: 'signed', valid: false, reason: 'EXPIRED' };
    }

    return {
        format: 'signed',
        valid: true,
        payload,
    };
}

/**
 * Mint a rotating per-participant campus-entry QR.
 *
 * Payload is intentionally minimal: {eid, pid, exp, n} so the QR code
 * grid stays sparse and easy to scan from a phone. The token is
 * verifiable offline (HMAC), so QR refresh is a pure-compute path —
 * no DB hit, no cache lookup. That is what lets us serve 10k
 * students refreshing every ~10-20s without touching Mongo.
 *
 * TTL is short (spec: no countdown visible to the student). Values
 * below 10s are rejected because they will race with slow scanners.
 */
function createParticipantQrToken({ eventId, participantId, ttlSeconds = 20 }) {
    if (!eventId) throw new Error('eventId required');
    if (!participantId) throw new Error('participantId required');

    const nowSec = Math.floor(Date.now() / 1000);
    const clampedTtl = Math.min(60, Math.max(10, Number(ttlSeconds) || 20));
    const expSec = nowSec + clampedTtl;

    const payload = {
        eid: String(eventId),
        pid: String(participantId),
        exp: expSec,
        n: crypto.randomBytes(3).toString('hex'),
    };

    const payloadSegment = base64UrlEncode(JSON.stringify(payload));
    const signatureSegment = signPayload(payloadSegment).slice(0, 12);

    return {
        token: `${EVENT_PARTICIPANT_QR_VERSION}.${payloadSegment}.${signatureSegment}`,
        expiresAt: new Date(expSec * 1000),
        ttlSeconds: clampedTtl,
    };
}

function verifyEventQrToken(token) {
    // Try participant format first — it's the hot path for the campus-entry
    // scanner. If it doesn't match the version prefix, verifySignedToken
    // returns { reason: 'UNSUPPORTED_FORMAT' } cheaply.
    const participantResult = verifySignedToken(EVENT_PARTICIPANT_QR_VERSION, token);
    if (participantResult.valid) {
        const payload = participantResult.payload || {};
        if (!payload.eid || !payload.pid) {
            return { format: 'event_participant', valid: false, reason: 'MALFORMED' };
        }
        return {
            format: 'event_participant',
            valid: true,
            payload: {
                eventId: String(payload.eid),
                participantId: String(payload.pid),
                expiresAt: new Date(Number(payload.exp) * 1000),
                tokenType: 'PARTICIPANT',
            },
        };
    }

    const stayResult = verifySignedToken(EVENT_STAY_QR_VERSION, token);
    if (stayResult.valid) {
        const payload = stayResult.payload || {};
        if (!payload.eid) {
            return { format: 'event_stay', valid: false, reason: 'MALFORMED' };
        }

        return {
            format: 'event_stay',
            valid: true,
            payload: {
                eventId: String(payload.eid),
                eventName: payload.enm ? String(payload.enm) : null,
                createdById: payload.cb ? String(payload.cb) : null,
                expiresAt: new Date(Number(payload.exp) * 1000),
                tokenType: 'STAY',
            },
        };
    }

    const messResult = verifySignedToken(EVENT_MESS_QR_VERSION, token);
    if (messResult.valid) {
        const payload = messResult.payload || {};
        const maybeMealNumber = Number(payload.meal);
        const mealNumber = Number.isInteger(maybeMealNumber) && maybeMealNumber > 0 ? maybeMealNumber : null;

        if (!payload.eid) {
            return { format: 'event_mess', valid: false, reason: 'MALFORMED' };
        }

        return {
            format: 'event_mess',
            valid: true,
            payload: {
                eventId: String(payload.eid),
                mealNumber,
                mealLabel: payload.mlb ? String(payload.mlb) : null,
                expiresAt: new Date(Number(payload.exp) * 1000),
                tokenType: 'MESS',
            },
        };
    }

    // Fall through: return the most specific reason we saw (participant
    // is checked first, so if it looked participant-shaped but failed on
    // signature we surface that; otherwise the stay/mess reason).
    const specific = [participantResult, stayResult, messResult].find(
        (r) => r?.reason && r.reason !== 'UNSUPPORTED_FORMAT',
    );
    return {
        format: 'unknown',
        valid: false,
        reason: specific?.reason || 'UNSUPPORTED_FORMAT',
    };
}

module.exports = {
    EVENT_STAY_QR_VERSION,
    EVENT_MESS_QR_VERSION,
    EVENT_PARTICIPANT_QR_VERSION,
    createEventStayQrToken,
    createEventMessQrToken,
    createParticipantQrToken,
    verifyEventQrToken,
};
