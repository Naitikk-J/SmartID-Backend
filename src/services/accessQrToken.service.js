const crypto = require('crypto');
const config = require('../config/env');

const ACCESS_QR_TOKEN_VERSION = 'aq1';

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
    return String(process.env.ACCESS_QR_SIGNING_SECRET || config.JWT_SECRET || '');
}

function signPayload(payloadSegment) {
    const secret = getSigningSecret();
    return base64UrlEncode(
        crypto.createHmac('sha256', secret).update(payloadSegment).digest(),
    );
}

function normalizeGeofence(geofence) {
    if (!geofence || typeof geofence !== 'object') return null;

    const centerLat = Number(geofence.center_lat ?? geofence.lat);
    const centerLng = Number(geofence.center_lng ?? geofence.lng);
    const radius = Number(geofence.radius ?? geofence.r);
    const shape = geofence.shape === 'POLYGON' ? 'POLYGON' : 'CIRCLE';

    if (!Number.isFinite(centerLat) || !Number.isFinite(centerLng) || !Number.isFinite(radius)) {
        return null;
    }

    return {
        center_lat: centerLat,
        center_lng: centerLng,
        radius,
        shape,
    };
}

function createAccessQrToken({ gateId, gateName, createdById, ttlSeconds, geofence }) {
    const nowSec = Math.floor(Date.now() / 1000);
    const expSec = nowSec + Math.max(1, Number(ttlSeconds) || 30);
    const normalizedGeofence = normalizeGeofence(geofence);

    // Compact payload: omit nulls and use short nonce to minimize QR code grid density
    const payload = {
        gid: String(gateId),
        exp: expSec,
        n: crypto.randomBytes(3).toString('hex'),
        ...(gateName ? { gnm: String(gateName) } : {}),
        ...(createdById ? { cb: String(createdById) } : {}),
        ...(normalizedGeofence
            ? {
                g: {
                    lat: normalizedGeofence.center_lat,
                    lng: normalizedGeofence.center_lng,
                    r: normalizedGeofence.radius,
                    s: normalizedGeofence.shape,
                },
            }
            : {}),
    };

    const payloadSegment = base64UrlEncode(JSON.stringify(payload));
    const signatureSegment = signPayload(payloadSegment).slice(0, 12);

    return {
        token: `${ACCESS_QR_TOKEN_VERSION}.${payloadSegment}.${signatureSegment}`,
        expiresAt: new Date(expSec * 1000),
    };
}

function verifyAccessQrToken(token) {
    if (typeof token !== 'string') {
        return { format: 'unknown', valid: false, reason: 'MALFORMED' };
    }

    const trimmed = token.trim();
    if (!trimmed.startsWith(`${ACCESS_QR_TOKEN_VERSION}.`)) {
        return { format: 'unknown', valid: false, reason: 'UNSUPPORTED_FORMAT' };
    }

    const segments = trimmed.split('.');
    if (segments.length !== 3) {
        return { format: 'stateless', valid: false, reason: 'MALFORMED' };
    }

    const [, payloadSegment, signatureSegment] = segments;
    const fullExpectedSignature = signPayload(payloadSegment);
    const expectedSignature = fullExpectedSignature.slice(0, signatureSegment.length);

    const providedBuffer = Buffer.from(signatureSegment);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (providedBuffer.length !== expectedBuffer.length
        || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
        return { format: 'stateless', valid: false, reason: 'INVALID_SIGNATURE' };
    }

    let payload;
    try {
        payload = JSON.parse(base64UrlDecode(payloadSegment));
    } catch {
        return { format: 'stateless', valid: false, reason: 'MALFORMED' };
    }

    if (!payload?.gid) {
        return { format: 'stateless', valid: false, reason: 'MALFORMED' };
    }

    const exp = Number(payload.exp);
    if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
        return { format: 'stateless', valid: false, reason: 'EXPIRED' };
    }

    return {
        format: 'stateless',
        valid: true,
        payload: {
            gateId: String(payload.gid),
            gateName: payload.gnm ? String(payload.gnm) : null,
            createdById: payload.cb ? String(payload.cb) : null,
            expiresAt: new Date(exp * 1000),
            geofence: payload.g
                ? normalizeGeofence({
                    center_lat: payload.g.lat,
                    center_lng: payload.g.lng,
                    radius: payload.g.r,
                    shape: payload.g.s,
                })
                : null,
        },
    };
}

module.exports = {
    ACCESS_QR_TOKEN_VERSION,
    createAccessQrToken,
    verifyAccessQrToken,
};
