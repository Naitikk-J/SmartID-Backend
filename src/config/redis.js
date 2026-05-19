// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Shared Redis Client Singleton
//
// Single ioredis instance reused across the entire app. Designed
// to survive Redis being unreachable (every consumer must handle
// `null` returns) and to never block a request for more than the
// configured command timeout.
// ═══════════════════════════════════════════════════════════════

const Redis = require('ioredis');
const config = require('./env');
const logger = require('./logger');

const DEFAULT_COMMAND_TIMEOUT_MS = 1000;

let client = null;
let attemptedInit = false;
let lastErrorAt = 0;
let isUp = false;

function buildClient() {
    if (!config.REDIS_URL) return null;

    const instance = new Redis(config.REDIS_URL, {
        connectTimeout: 1500,
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        enableOfflineQueue: false,
        commandTimeout: DEFAULT_COMMAND_TIMEOUT_MS,
        // Back off forever but slowly; never hammer Redis when it is down.
        retryStrategy: (times) => Math.min(30000, times * 1000),
        lazyConnect: false,
    });

    instance.on('connect', () => {
        isUp = true;
        logger.info('Redis connected');
    });

    instance.on('ready', () => {
        isUp = true;
    });

    instance.on('error', (err) => {
        isUp = false;
        // Throttle error logs — one per 10s is plenty.
        const now = Date.now();
        if (now - lastErrorAt > 10000) {
            lastErrorAt = now;
            logger.warn('Redis error', { message: err.message });
        }
    });

    instance.on('end', () => {
        isUp = false;
    });

    return instance;
}

/**
 * Returns the shared Redis client, or `null` if Redis is not configured.
 * Callers MUST handle `null` and treat it as "Redis unavailable, fall back".
 */
function getRedis() {
    if (client) return client;
    if (attemptedInit) return null;
    attemptedInit = true;

    try {
        client = buildClient();
    } catch (err) {
        logger.warn('Failed to initialise Redis client', { message: err.message });
        client = null;
    }

    return client;
}

/**
 * Run a Redis command with a hard timeout. Returns `null` (never throws)
 * if Redis is down, slow, or the command rejects.
 */
async function safeCall(commandPromise, label = 'redis') {
    if (!commandPromise || typeof commandPromise.then !== 'function') return null;
    try {
        return await Promise.race([
            commandPromise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`${label} timed out`)), DEFAULT_COMMAND_TIMEOUT_MS),
            ),
        ]);
    } catch (err) {
        // Quietly swallow — Redis must never break the request path.
        return null;
    }
}

function isRedisUp() {
    return isUp;
}

async function shutdown() {
    if (!client) return;
    try {
        await client.quit();
    } catch (err) {
        logger.warn('Redis quit failed', { message: err.message });
    } finally {
        client = null;
        isUp = false;
    }
}

module.exports = { getRedis, safeCall, isRedisUp, shutdown, DEFAULT_COMMAND_TIMEOUT_MS };
