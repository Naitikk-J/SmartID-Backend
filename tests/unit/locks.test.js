describe('locks (Redis SET NX)', () => {
    const mockRedis = {
        store: new Map(),
        async set(key, value, _px, _ttl, mode) {
            if (mode === 'NX' && this.store.has(key)) return null;
            this.store.set(key, value);
            return 'OK';
        },
        async get(key) { return this.store.get(key) ?? null; },
        async del(key) { this.store.delete(key); return 1; },
    };

    beforeEach(() => mockRedis.store.clear());

    beforeAll(() => {
        jest.doMock('../../src/config/redis', () => ({
            getRedis: () => mockRedis,
            safeCall: async (p) => { try { return await p; } catch { return null; } },
            isRedisUp: () => true,
            shutdown: async () => {},
            DEFAULT_COMMAND_TIMEOUT_MS: 1000,
        }));
    });

    afterAll(() => jest.dontMock('../../src/config/redis'));

    test('only one of two concurrent withLock calls runs fn', async () => {
        const { withLock } = require('../../src/utils/locks');
        const ran = [];

        const a = withLock('k', 1000, async () => {
            ran.push('A');
            await new Promise((r) => setTimeout(r, 30));
        }, () => { ran.push('A-locked'); });

        const b = withLock('k', 1000, async () => {
            ran.push('B');
        }, () => { ran.push('B-locked'); });

        await Promise.all([a, b]);
        expect(ran.filter((x) => x === 'A' || x === 'B').length).toBe(1);
        expect(ran).toContain('A');
        expect(ran).toContain('B-locked');
    });

    test('when Redis is down, withLock invokes onLocked', async () => {
        jest.resetModules();
        jest.doMock('../../src/config/redis', () => ({
            getRedis: () => null,
            safeCall: async () => null,
            isRedisUp: () => false,
            shutdown: async () => {},
            DEFAULT_COMMAND_TIMEOUT_MS: 1000,
        }));
        const { withLock } = require('../../src/utils/locks');

        let mainCalled = false;
        let fallbackCalled = false;
        await withLock('any', 100, () => { mainCalled = true; }, () => { fallbackCalled = true; });
        expect(mainCalled).toBe(false);
        expect(fallbackCalled).toBe(true);
    });
});
