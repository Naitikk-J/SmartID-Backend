// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Express Application Setup
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const config = require('./config/env');
const logger = require('./config/logger');
const { errorHandler, AppError } = require('./middleware/errorHandler');

// ── Route imports ────────────────────────────────────────────
function routeFallback(routeName, err) {
    logger.error(`Failed to load route module: ${routeName}`, {
        routeName,
        error: err.message,
        stack: err.stack,
    });

    const fallback = express.Router();
    fallback.all('*', (req, res) => {
        res.status(503).json({
            success: false,
            error: `${routeName} route is temporarily unavailable`,
        });
    });
    return fallback;
}

let authRoutes;
let scanRoutes;
let studentRoutes;
let attendanceRoutes;
let gateRoutes;
let eventRoutes;
let libraryRoutes;
let electionRoutes;
let reportRoutes;
let adminRoutes;
let accessRoutes;
let qrRoutes;
let pinkSlipRoutes;
let alertRoutes;
let curfewRoutes;
let lateReturnRoutes;
let geofencingRoutes;
let rfidRoutes;
let campusEntryRoutes;

try { authRoutes = require('./routes/auth.routes'); } catch (err) { authRoutes = routeFallback('auth', err); }
try { scanRoutes = require('./routes/scan.routes'); } catch (err) { scanRoutes = routeFallback('scan', err); }
try { studentRoutes = require('./routes/students.routes'); } catch (err) { studentRoutes = routeFallback('students', err); }
try { attendanceRoutes = require('./routes/attendance.routes'); } catch (err) { attendanceRoutes = routeFallback('attendance', err); }
try { gateRoutes = require('./routes/gates.routes'); } catch (err) { gateRoutes = routeFallback('gates', err); }
try { eventRoutes = require('./routes/events.routes'); } catch (err) { eventRoutes = routeFallback('events', err); }
try { libraryRoutes = require('./routes/library.routes'); } catch (err) { libraryRoutes = routeFallback('library', err); }
try { electionRoutes = require('./routes/elections.routes'); } catch (err) { electionRoutes = routeFallback('elections', err); }
try { reportRoutes = require('./routes/reports.routes'); } catch (err) { reportRoutes = routeFallback('reports', err); }
try { adminRoutes = require('./routes/admin.routes'); } catch (err) { adminRoutes = routeFallback('admin', err); }
try { accessRoutes = require('./routes/access.routes'); } catch (err) { accessRoutes = routeFallback('access', err); }
try { qrRoutes = require('./routes/qr.routes'); } catch (err) { qrRoutes = routeFallback('qr', err); }
try { pinkSlipRoutes = require('./routes/pink-slip.routes'); } catch (err) { pinkSlipRoutes = routeFallback('pink-slip', err); }
try { alertRoutes = require('./routes/alerts.routes'); } catch (err) { alertRoutes = routeFallback('alerts', err); }
try { curfewRoutes = require('./routes/curfew.routes'); } catch (err) { curfewRoutes = routeFallback('curfew', err); }
try { lateReturnRoutes = require('./routes/late-return.routes'); } catch (err) { lateReturnRoutes = routeFallback('late-return', err); }
try { geofencingRoutes = require('./routes/geofencing.routes'); } catch (err) { geofencingRoutes = routeFallback('geofencing', err); }
try { rfidRoutes = require('./routes/rfid.routes'); } catch (err) { rfidRoutes = routeFallback('rfid', err); }
try { campusEntryRoutes = require('./routes/campus-entry.routes'); } catch (err) { campusEntryRoutes = routeFallback('campus-entry', err); }


const app = express();

// ── 1. Security headers ─────────────────────────────────────
// HSTS only when explicitly behind HTTPS (Vercel terminates TLS).
//
// CSP is shipped in REPORT-ONLY mode in production so violations
// stream to `report-uri` without breaking pages. Flip to enforcing
// (`contentSecurityPolicy`) once the admin team has confirmed the
// report stream is empty for a full sprint. Disabled in dev to
// keep HMR/inspectors quiet.
const useReportOnlyCsp = process.env.NODE_ENV === 'production' && process.env.CSP_ENABLED !== 'false';
const cspDirectives = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'"], // Admin app currently inlines bootstrap config.
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
    connectSrc: ["'self'", 'https:', 'wss:'],
    frameAncestors: ["'none'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    upgradeInsecureRequests: [],
};
if (process.env.CSP_REPORT_URI) cspDirectives.reportUri = [process.env.CSP_REPORT_URI];

app.use(helmet({
    contentSecurityPolicy: useReportOnlyCsp
        ? { directives: cspDirectives, reportOnly: true }
        : false,
    crossOriginEmbedderPolicy: false, // Allow embedding face-AI iframes / images.
    hsts: process.env.NODE_ENV === 'production'
        ? { maxAge: 60 * 60 * 24 * 180, includeSubDomains: true, preload: false }
        : false,
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    hidePoweredBy: true,
    noSniff: true,
}));

// ── 2. CORS ──────────────────────────────────────────────────
const allowedOrigins = [
    'http://localhost:5173',
    'https://smartid.naitik.site'
];

// Add from env if present
if (config.DASHBOARD_URL) {
    config.DASHBOARD_URL.split(',').forEach(o => {
        const origin = o.trim();
        if (origin && !allowedOrigins.includes(origin)) {
            allowedOrigins.push(origin);
        }
    });
}

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (e.g. mobile apps, curl, Postman)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        // Instead of throwing an error, just return false
        callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── 3. Body parsing ─────────────────────────────────────────
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: false, limit: '25mb' }));

// ── 4. Request ID ───────────────────────────────────────────
app.use((req, res, next) => {
    req.requestId = uuidv4();
    res.setHeader('X-Request-Id', req.requestId);
    next();
});

// ── 5. Request logger ───────────────────────────────────────
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        logger.info({
            requestId: req.requestId,
            method: req.method,
            url: req.originalUrl,
            status: res.statusCode,
            duration: `${duration}ms`,
        });
    });
    next();
});

// ── 6. Health check ─────────────────────────────────────────
app.get(['/health', '/api/v1/health'], (req, res) => {
    const { getGeofencingSettings } = require('./services/geofencing-settings.service');
    const { isRedisUp } = require('./config/redis');
    const { stats: cacheStats } = require('./services/cache.service');
    const memory = process.memoryUsage();
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime_s: Math.round(process.uptime()),
        redis: isRedisUp() ? 'up' : 'down',
        cache: cacheStats(),
        memory: {
            rss_mb: Math.round(memory.rss / 1024 / 1024),
            heapUsed_mb: Math.round(memory.heapUsed / 1024 / 1024),
        },
        geofencing: getGeofencingSettings(),
    });
});

// ── 6a. Deep health check — pings every external dependency ─
app.get(['/health/deep', '/api/v1/health/deep'], async (req, res) => {
    const checks = await runDeepHealthChecks(2500);
    const allOk = Object.values(checks).every((c) => c.status === 'ok' || c.status === 'skipped');
    res.status(allOk ? 200 : 503).json({
        status: allOk ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        checks,
    });
});

// ── 6c. Ops metrics (CRON_SECRET-gated) ─────────────────────
app.get(['/metrics', '/api/v1/metrics'], (req, res) => {
    const config = require('./config/env');
    if (config.CRON_SECRET) {
        const provided = req.headers['x-metrics-token'] || req.query.token;
        if (provided !== config.CRON_SECRET) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
    }

    const { isRedisUp } = require('./config/redis');
    const { stats: cacheStats } = require('./services/cache.service');
    const faceAi = (() => {
        try { return require('./services/faceAi.service').breaker?.snapshot?.(); }
        catch { return null; }
    })();
    const memory = process.memoryUsage();
    res.json({
        timestamp: new Date().toISOString(),
        uptime_s: Math.round(process.uptime()),
        node: process.version,
        pid: process.pid,
        memory: {
            rss_mb: Math.round(memory.rss / 1024 / 1024),
            heapUsed_mb: Math.round(memory.heapUsed / 1024 / 1024),
            heapTotal_mb: Math.round(memory.heapTotal / 1024 / 1024),
            external_mb: Math.round(memory.external / 1024 / 1024),
        },
        redis: { up: isRedisUp() },
        cache: cacheStats(),
        breakers: { faceAi },
    });
});

// ── 6b. App-wide general rate limit ─────────────────────────
try {
    const { generalRateLimit } = require('./middleware/rateLimit');
    app.use('/api/', generalRateLimit);
} catch (err) {
    logger.warn('General rate limit failed to load — running without it', { message: err.message });
}

/**
 * Run health checks against every external dependency with a hard
 * timeout per check. Returns a `{ name: { status, latency_ms, ... } }`
 * map and never throws — every error is reported as a check failure.
 */
async function runDeepHealthChecks(perCheckTimeoutMs = 2500) {
    const checks = {};
    const withTimeout = (label, p) => Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), perCheckTimeoutMs)),
    ]);

    // Prisma / Mongo
    {
        const t0 = Date.now();
        try {
            const prisma = require('./config/database');
            await withTimeout('db', prisma.$runCommandRaw({ ping: 1 }));
            checks.database = { status: 'ok', latency_ms: Date.now() - t0 };
        } catch (err) {
            checks.database = { status: 'down', latency_ms: Date.now() - t0, error: err.message };
        }
    }

    // Redis
    {
        const t0 = Date.now();
        try {
            const { getRedis } = require('./config/redis');
            const r = getRedis();
            if (!r) {
                checks.redis = { status: 'skipped', reason: 'REDIS_URL not configured' };
            } else {
                const pong = await withTimeout('redis', r.ping());
                checks.redis = { status: pong === 'PONG' ? 'ok' : 'down', latency_ms: Date.now() - t0 };
            }
        } catch (err) {
            checks.redis = { status: 'down', latency_ms: Date.now() - t0, error: err.message };
        }
    }

    // Face AI (optional — soft fail if not deployed)
    {
        const t0 = Date.now();
        try {
            const faceAi = require('./services/faceAi.service');
            await withTimeout('faceAi', faceAi.healthcheck());
            checks.faceAi = { status: 'ok', latency_ms: Date.now() - t0 };
        } catch (err) {
            checks.faceAi = { status: 'down', latency_ms: Date.now() - t0, error: err.message };
        }
    }

    return checks;
}
// Exposed so tests can hit it directly without a live server.
app.locals.runDeepHealthChecks = runDeepHealthChecks;

// ── 7. Mount routes ─────────────────────────────────────────
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/scan', scanRoutes);
app.use('/api/v1/students', studentRoutes);
app.use('/api/v1/attendance', attendanceRoutes);
app.use('/api/v1/gates', gateRoutes);
app.use('/api/v1/events', eventRoutes);
app.use('/api/v1/library', libraryRoutes);
app.use('/api/v1/elections', electionRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/pink-slips', pinkSlipRoutes);
app.use('/api/v1/access', accessRoutes);
app.use('/api/v1/qr', qrRoutes);
app.use('/api/v1/alerts', alertRoutes);
app.use('/api/v1/rules/curfew', curfewRoutes);
app.use('/api/v1/late-return', lateReturnRoutes);
app.use('/api/v1/geofencing', geofencingRoutes);
app.use('/api/v1/rfid', rfidRoutes);
app.use('/api/v1/campus-entry', campusEntryRoutes);

// ── 8. 404 handler ──────────────────────────────────────────
app.all('*', (req, res, next) => {
    next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
});

// ── 9. Global error handler ─────────────────────────────────
app.use(errorHandler);

module.exports = app;
