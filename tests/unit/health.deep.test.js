// Exercises the deep-health logic without spinning up a real server.

// All external dependencies are mocked so we can drive each check
// independently into ok/degraded/timeout states.

const mockPrisma = { $runCommandRaw: jest.fn() };
jest.mock('../../src/config/database', () => mockPrisma);

const mockRedisClient = { ping: jest.fn() };
let mockRedisUp = true;
jest.mock('../../src/config/redis', () => ({
    getRedis: () => (mockRedisUp ? mockRedisClient : null),
    safeCall: async (p) => { try { return await p; } catch { return null; } },
    isRedisUp: () => mockRedisUp,
    shutdown: async () => {},
}));

const mockFaceAi = { healthcheck: jest.fn() };
jest.mock('../../src/services/faceAi.service', () => mockFaceAi);

const app = require('../../src/app');

const runChecks = (timeout) => app.locals.runDeepHealthChecks(timeout);

describe('runDeepHealthChecks', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisUp = true;
    });

    test('all green when every dependency answers in time', async () => {
        mockPrisma.$runCommandRaw.mockResolvedValue({ ok: 1 });
        mockRedisClient.ping.mockResolvedValue('PONG');
        mockFaceAi.healthcheck.mockResolvedValue(true);

        const checks = await runChecks(500);
        expect(checks.database.status).toBe('ok');
        expect(checks.redis.status).toBe('ok');
        expect(checks.faceAi.status).toBe('ok');
    });

    test('flags database as down on error', async () => {
        mockPrisma.$runCommandRaw.mockRejectedValue(new Error('connection lost'));
        mockRedisClient.ping.mockResolvedValue('PONG');
        mockFaceAi.healthcheck.mockResolvedValue(true);

        const checks = await runChecks(500);
        expect(checks.database.status).toBe('down');
        expect(checks.database.error).toMatch(/connection lost/);
    });

    test('reports redis as skipped when not configured', async () => {
        mockRedisUp = false;
        mockPrisma.$runCommandRaw.mockResolvedValue({ ok: 1 });
        mockFaceAi.healthcheck.mockResolvedValue(true);

        const checks = await runChecks(500);
        expect(checks.redis.status).toBe('skipped');
    });

    test('flags face AI as down without taking down the whole check', async () => {
        mockPrisma.$runCommandRaw.mockResolvedValue({ ok: 1 });
        mockRedisClient.ping.mockResolvedValue('PONG');
        mockFaceAi.healthcheck.mockRejectedValue(new Error('ECONNREFUSED'));

        const checks = await runChecks(500);
        expect(checks.database.status).toBe('ok');
        expect(checks.faceAi.status).toBe('down');
    });

    test('honours per-check timeout', async () => {
        mockPrisma.$runCommandRaw.mockImplementation(() => new Promise(() => { /* never resolves */ }));
        mockRedisClient.ping.mockResolvedValue('PONG');
        mockFaceAi.healthcheck.mockResolvedValue(true);

        const t0 = Date.now();
        const checks = await runChecks(50);
        const elapsed = Date.now() - t0;
        expect(checks.database.status).toBe('down');
        expect(elapsed).toBeLessThan(1000);
    });
});
