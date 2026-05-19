// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Prisma Client Singleton
//
// Singleton with:
//   - hot-reload-safe global cache (dev)
//   - slow-query warning via $on('query')  (>SLOW_QUERY_MS)
//   - error event piped to winston
//   - lazy init via Proxy so importing the module never throws
// ═══════════════════════════════════════════════════════════════

const { PrismaClient } = require('@prisma/client');

const SLOW_QUERY_MS = Number(process.env.PRISMA_SLOW_QUERY_MS || 500);

let prisma = null;
let initError = null;
let loggerCache = null;

function getLogger() {
    if (loggerCache) return loggerCache;
    try {
        loggerCache = require('./logger');
    } catch {
        loggerCache = console;
    }
    return loggerCache;
}

function attachListeners(client) {
    try {
        client.$on('query', (e) => {
            if (e.duration >= SLOW_QUERY_MS) {
                getLogger().warn('[prisma] slow query', {
                    duration_ms: e.duration,
                    query: typeof e.query === 'string' ? e.query.slice(0, 240) : undefined,
                });
            }
        });
    } catch {
        /* `query` event requires `log: [{level:'query', emit:'event'}]` — set below */
    }
    try {
        client.$on('error', (e) => {
            getLogger().error('[prisma] error', { message: e?.message });
        });
    } catch { /* ignore */ }
    try {
        client.$on('warn', (e) => {
            getLogger().warn('[prisma] warn', { message: e?.message });
        });
    } catch { /* ignore */ }
}

function buildClient() {
    const isProd = process.env.NODE_ENV === 'production';
    const client = new PrismaClient({
        log: [
            { emit: 'event', level: 'query' },
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
        ],
        errorFormat: isProd ? 'minimal' : 'pretty',
    });
    attachListeners(client);
    return client;
}

function initializePrisma() {
    if (prisma) return prisma;
    if (initError) throw initError;

    try {
        if (process.env.NODE_ENV === 'production') {
            prisma = buildClient();
        } else {
            // Prevent multiple instances during hot reload in development
            if (!global.__prisma) {
                global.__prisma = buildClient();
            }
            prisma = global.__prisma;
        }
        return prisma;
    } catch (err) {
        initError = err;
        getLogger().error('Failed to initialize Prisma client', { message: err.message });
        throw err;
    }
}

module.exports = new Proxy({}, {
    get: (target, prop) => {
        const client = initializePrisma();
        return client ? client[prop] : undefined;
    },
});

// Test helper — never use in production code.
module.exports.__getClient = () => initializePrisma();
