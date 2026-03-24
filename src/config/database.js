// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Prisma Client Singleton
// ═══════════════════════════════════════════════════════════════

const { PrismaClient } = require('@prisma/client');

let prisma = null;
let initError = null;

function initializePrisma() {
    if (prisma) return prisma;
    if (initError) throw initError;

    try {
        if (process.env.NODE_ENV === 'production') {
            prisma = new PrismaClient();
        } else {
            // Prevent multiple instances during hot reload in development
            if (!global.__prisma) {
                global.__prisma = new PrismaClient({
                    log: ['query', 'warn', 'error'],
                });
            }
            prisma = global.__prisma;
        }
        return prisma;
    } catch (err) {
        initError = err;
        console.error('Failed to initialize Prisma client:', err.message);
        throw err;
    }
}

module.exports = new Proxy({}, {
    get: (target, prop) => {
        const client = initializePrisma();
        return client ? client[prop] : undefined;
    },
});
