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
const authRoutes = require('./routes/auth.routes');
const scanRoutes = require('./routes/scan.routes');
const studentRoutes = require('./routes/students.routes');
const attendanceRoutes = require('./routes/attendance.routes');
const gateRoutes = require('./routes/gates.routes');
const eventRoutes = require('./routes/events.routes');
const libraryRoutes = require('./routes/library.routes');
const walletRoutes = require('./routes/wallet.routes');
const electionRoutes = require('./routes/elections.routes');
const reportRoutes = require('./routes/reports.routes');
const adminRoutes = require('./routes/admin.routes');

const app = express();

// ── 1. Security headers ─────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: false,
}));

// ── 2. CORS ──────────────────────────────────────────────────
const allowedOrigins = (config.DASHBOARD_URL || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (e.g. mobile apps, curl, Postman)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Pre-flight for all routes
app.options('*', cors());

// ── 3. Body parsing ─────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

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
app.use('/api/v1/wallet', walletRoutes);
app.use('/api/v1/elections', electionRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use('/api/v1/admin', adminRoutes);

// ── 8. 404 handler ──────────────────────────────────────────
app.all('*', (req, res, next) => {
    next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
});

// ── 9. Global error handler ─────────────────────────────────
app.use(errorHandler);

module.exports = app;
