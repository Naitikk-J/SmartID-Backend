// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Rate Limiting Configuration
// ═══════════════════════════════════════════════════════════════

const rateLimit = require('express-rate-limit');

// Scan verify endpoint: 30 req/min per IP
const scanRateLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: {
        success: false,
        error: 'Too many scan requests — limit is 30 per minute',
        code: 'RATE_LIMITED',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Auth login: 10 req/15min per IP (brute force protection)
const loginRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: {
        success: false,
        error: 'Too many login attempts — please try again in 15 minutes',
        code: 'RATE_LIMITED',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// General: 100 req/min per IP
const generalRateLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: {
        success: false,
        error: 'Too many requests — please slow down',
        code: 'RATE_LIMITED',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = { scanRateLimit, loginRateLimit, generalRateLimit };
