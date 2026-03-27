// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — HTTP + Socket.io Server Bootstrap
// ═══════════════════════════════════════════════════════════════

const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const app = require('./app');
const config = require('./config/env');
const logger = require('./config/logger');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');

// ── Prisma Client (singleton, lazy-loaded) ────────────────
let prismaInstance = null;
function getPrismaForSocket() {
    if (!prismaInstance) {
        try {
            prismaInstance = new PrismaClient();
        } catch (err) {
            logger.error('Failed to initialize Prisma for socket:', err);
            prismaInstance = null;
        }
    }
    return prismaInstance;
}
module.exports.prisma = null; // Will use getPrismaForSocket when needed

// ── Redis Client (singleton, lazy-loaded) ──────────────────
let redisInstance = null;
function getRedisForSocket() {
    if (!redisInstance) {
        try {
            redisInstance = new Redis(config.REDIS_URL);
            redisInstance.on('error', (err) => logger.error('Redis error:', err));
            redisInstance.on('connect', () => logger.info('Redis connected'));
        } catch (err) {
            logger.error('Failed to initialize Redis for socket:', err);
            redisInstance = null;
        }
    }
    return redisInstance;
}
module.exports.redis = null; // Will use getRedisForSocket when needed
module.exports.getPrisma = getPrismaForSocket;
module.exports.getRedis = getRedisForSocket;


// ── HTTP Server ─────────────────────────────────────────────
const server = http.createServer(app);

// ── Socket.io ───────────────────────────────────────────────
const io = new Server(server, {
    cors: {
        origin: config.DASHBOARD_URL,
        credentials: true,
    },
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
const gracefulShutdown = async (signal) => {
    logger.info(`${signal} received. Shutting down gracefully...`);
    server.close(async () => {
        const p = getPrismaForSocket();
        const r = getRedisForSocket();
        if (p) await p.$disconnect().catch(err => logger.error('Prisma disconnect error:', err));
        if (r) await r.quit().catch(err => logger.error('Redis quit error:', err));
        logger.info('Server closed.');
        process.exit(0);
    });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
