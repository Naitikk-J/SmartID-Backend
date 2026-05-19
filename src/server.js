// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — HTTP + Socket.io Server Bootstrap
// ═══════════════════════════════════════════════════════════════

const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const app = require('./app');
const config = require('./config/env');
const logger = require('./config/logger');
const prisma = require('./config/database');
const { getRedis, shutdown: shutdownRedis } = require('./config/redis');

// ── Sentry (optional) ───────────────────────────────────────
if (config.SENTRY_DSN) {
    try {
        // Lazy require so the dependency is optional.
        const Sentry = require('@sentry/node');
        Sentry.init({
            dsn: config.SENTRY_DSN,
            environment: config.NODE_ENV,
            tracesSampleRate: 0.05,
        });
        logger.info('Sentry initialised');
    } catch (err) {
        logger.warn('SENTRY_DSN set but @sentry/node is not installed — skipping');
    }
}

// Backward-compat exports for any caller still using the old shape.
module.exports.getPrisma = () => prisma;
module.exports.getRedis = getRedis;


// ── HTTP Server ─────────────────────────────────────────────
const server = http.createServer(app);

// ── Socket.io ───────────────────────────────────────────────
//
// Serverless platforms (Vercel/Cloudflare/etc.) cannot keep
// long-lived WebSocket upgrades alive across function invocations,
// so we skip the Socket.IO server entirely on those environments
// and rely on the SSE hub at /api/v1/scan/stream (or short-poll
// /api/v1/scan/recent?since=<ts>) for real-time updates.
//
// In every other environment we initialise Socket.IO as usual.
let io = null;
const onServerless = Boolean(process.env.VERCEL || process.env.NETLIFY);

if (onServerless) {
    logger.warn(
        'Serverless environment detected (VERCEL/NETLIFY) — Socket.IO disabled. ' +
        'Admin dashboards should subscribe to /api/v1/scan/stream (SSE) or poll ' +
        '/api/v1/scan/recent?since=<ISO> for live updates.',
    );
} else {
    io = new Server(server, {
        cors: { origin: config.DASHBOARD_URL, credentials: true },
    });

    // Socket.io auth middleware — verify JWT on handshake
    io.use((socket, next) => {
        const token = socket.handshake.auth?.token;
        if (!token) {
            return next(new Error('Authentication required'));
        }
        try {
            const decoded = jwt.verify(token, config.JWT_SECRET);
            socket.user = decoded;
            next();
        } catch (err) {
            next(new Error('Invalid token'));
        }
    });

    io.on('connection', (socket) => {
        logger.info(`Socket connected: ${socket.user.email} (${socket.user.role})`);

        // Join dashboard room for admins
        if (['SUPER_ADMIN', 'DEPT_ADMIN'].includes(socket.user.role)) {
            socket.join('dashboard');
        }

        socket.on('disconnect', () => {
            logger.info(`Socket disconnected: ${socket.user.email}`);
        });
    });
}

module.exports.io = io;

// ── Scheduled Jobs ──────────────────────────────────────────
try {
    require('./jobs/scheduler');
} catch (err) {
    logger.warn('Scheduled jobs not loaded:', err.message);
}

// ── Start Server ────────────────────────────────────────────
const PORT = config.PORT;
server.listen(PORT, () => {
    logger.info(`🚀 API running on port ${PORT}`);
    logger.info(`   Environment: ${config.NODE_ENV}`);
    logger.info(`   Dashboard CORS: ${config.DASHBOARD_URL}`);
});

// ── Graceful Shutdown ───────────────────────────────────────
let shuttingDown = false;
const gracefulShutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received. Shutting down gracefully...`);

    // Hard-kill if shutdown hangs.
    const killTimer = setTimeout(() => {
        logger.error('Forced exit — graceful shutdown timed out');
        process.exit(1);
    }, 10000);
    killTimer.unref?.();

    server.close(async () => {
        try {
            if (prisma?.$disconnect) {
                await prisma.$disconnect().catch((err) =>
                    logger.error('Prisma disconnect error', { message: err?.message }),
                );
            }
            await shutdownRedis();
        } finally {
            logger.info('Server closed.');
            clearTimeout(killTimer);
            process.exit(0);
        }
    });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── Last-line crash defence ─────────────────────────────────
// Never crash silently. Log and exit so the orchestrator (PM2,
// Docker, Vercel) restarts a healthy worker. Skipping on Vercel
// where the platform owns the lifecycle.
process.on('unhandledRejection', (reason, promise) => {
    logger.error('UNHANDLED_REJECTION', {
        reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason,
    });
});

process.on('uncaughtException', (err) => {
    logger.error('UNCAUGHT_EXCEPTION', { message: err?.message, stack: err?.stack });
    // Allow logger to flush, then exit so we don't keep serving with a
    // poisoned process state. Vercel/PM2 will restart us.
    if (!process.env.VERCEL) {
        setTimeout(() => process.exit(1), 250).unref?.();
    }
});
