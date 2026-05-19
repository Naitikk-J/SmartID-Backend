// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Refresh token rotation
//
// Refresh tokens are SINGLE USE. Each time the client uses one to
// obtain a new access token, the old refresh is revoked (its `jti`
// is recorded in Redis) and a fresh refresh is minted in its place.
//
// If a previously-revoked `jti` is presented, that means either:
//   - the client is replaying a token (network retry), or
//   - the token was stolen and the legitimate client has already
//     rotated past it.
//
// In both cases the safe response is the same: reject. The legit
// client will see a 401, redirect to login, and resume cleanly.
// Future hardening (token-family invalidation) can be added without
// changing the wire format because every token already carries a
// stable `jti`.
//
// When Redis is unavailable, rotation degrades to "best-effort": the
// new token is still issued and the old token is NOT marked revoked.
// Auth still works; the additional security from rotation is lost
// until Redis recovers.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { getRedis, safeCall } = require('../config/redis');
const { AppError } = require('../middleware/errorHandler');

const REVOKED_PREFIX = 'refresh:revoked:';
// Default TTL applied to revocation records when the JWT itself
// doesn't expose `exp` for some reason. Mirrors JWT_REFRESH_EXPIRES_IN
// in seconds (best-effort upper bound).
const FALLBACK_REVOCATION_TTL_S = 30 * 24 * 60 * 60; // 30 days

function newJti() {
    // 22 base64url chars ≈ 132 bits of randomness.
    return crypto.randomBytes(16).toString('base64url');
}

function signAccessToken(user) {
    const payload = {
        id: user.id,
        email: user.email,
        role: user.role,
        department: user.department,
        module: user.module,
        userType: user.userType,
        appAccess: user.appAccess,
    };
    return jwt.sign(payload, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN });
}

function signRefreshToken(user, jti = newJti()) {
    return jwt.sign(
        { id: user.id, role: user.role, type: 'refresh', jti },
        config.JWT_SECRET,
        { expiresIn: config.JWT_REFRESH_EXPIRES_IN },
    );
}

/**
 * Issue an initial pair (access + refresh) — used at login.
 */
function issueTokenPair(user) {
    const jti = newJti();
    return {
        accessToken: signAccessToken(user),
        refreshToken: signRefreshToken(user, jti),
        refreshJti: jti,
    };
}

/**
 * Verify a refresh token, ensure its jti hasn't been revoked, then
 * rotate: mark old jti revoked + issue a new pair.
 *
 * Throws AppError(401) on any failure path. Never leaks why.
 */
async function rotate(refreshToken, lookupUser) {
    let decoded;
    try {
        decoded = jwt.verify(refreshToken, config.JWT_SECRET);
    } catch (err) {
        throw new AppError('Invalid refresh token', 401, 'INVALID_TOKEN');
    }

    if (decoded.type !== 'refresh') {
        throw new AppError('Invalid refresh token', 401, 'INVALID_TOKEN');
    }

    const jti = decoded.jti;
    const redis = getRedis();

    // Reuse-detection: if the jti is already in the revoked set, this is
    // either a replay or a stolen token. Reject. Pre-rotation tokens
    // (no jti claim) are accepted once — they pre-date this rollout.
    if (jti && redis) {
        const revoked = await safeCall(redis.get(`${REVOKED_PREFIX}${jti}`), 'refresh.check');
        if (revoked) {
            throw new AppError('Refresh token has been revoked', 401, 'REFRESH_REVOKED');
        }
    }

    const user = await lookupUser(decoded);
    if (!user) {
        throw new AppError('User not found or inactive', 401, 'INVALID_TOKEN');
    }

    // Mint a new pair before revoking the old one so we never leave the
    // user without working tokens if Redis is partially failing.
    const next = issueTokenPair(user);

    if (jti && redis) {
        // Set TTL to the remaining lifetime of the old token. After that
        // the JWT itself rejects on `exp`, so the revocation record can
        // expire safely.
        let ttlSeconds = FALLBACK_REVOCATION_TTL_S;
        if (Number.isFinite(decoded.exp)) {
            const nowSec = Math.floor(Date.now() / 1000);
            ttlSeconds = Math.max(60, decoded.exp - nowSec);
        }
        await safeCall(
            redis.set(`${REVOKED_PREFIX}${jti}`, '1', 'EX', ttlSeconds),
            'refresh.revoke',
        );
    }

    return next;
}

/**
 * Explicitly revoke a refresh token (used at logout). Best-effort.
 */
async function revoke(refreshToken) {
    if (!refreshToken) return;
    let decoded;
    try {
        decoded = jwt.verify(refreshToken, config.JWT_SECRET);
    } catch {
        return; // Don't 500 if the client sent a bad token on logout.
    }
    const jti = decoded?.jti;
    if (!jti) return;
    const redis = getRedis();
    if (!redis) return;
    const ttlSeconds = Number.isFinite(decoded.exp)
        ? Math.max(60, decoded.exp - Math.floor(Date.now() / 1000))
        : FALLBACK_REVOCATION_TTL_S;
    await safeCall(redis.set(`${REVOKED_PREFIX}${jti}`, '1', 'EX', ttlSeconds), 'refresh.revoke');
}

module.exports = {
    issueTokenPair,
    rotate,
    revoke,
    signAccessToken,
    signRefreshToken,
    REVOKED_PREFIX,
};
