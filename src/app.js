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


const app = express();

// ── 1. Security headers ─────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: false,
}));

// ── 2. CORS ──────────────────────────────────────────────────
const allowedOrigins = [
    'http://localhost:5173',
    'https://smart-id-frontend-seven.vercel.app'
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
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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

// ── 8. 404 handler ──────────────────────────────────────────
app.all('*', (req, res, next) => {
    next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
});

// ── 9. Global error handler ─────────────────────────────────
app.use(errorHandler);

module.exports = app;
