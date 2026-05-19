// Cache works without Redis (L1 only). When Redis is unavailable,
// getRedis() returns null and all redis paths are no-ops.
jest.mock('../../src/config/redis', () => ({
    getRedis: () => null,
    safeCall: async () => null,
    isRedisUp: () => false,
    shutdown: async () => {},
    DEFAULT_COMMAND_TIMEOUT_MS: 1000,
}));

const cache = require('../../src/services/cache.service');

describe('cache.service (L1 only)', () => {
    beforeEach(() => cache._resetForTests());

    test('getOrLoad invokes loader once and caches the result', async () => {
        const loader = jest.fn().mockResolvedValue({ value: 1 });
        const a = await cache.getOrLoad('k1', loader, { ttlMs: 1000 });
        const b = await cache.getOrLoad('k1', loader, { ttlMs: 1000 });
        expect(a).toEqual({ value: 1 });
        expect(b).toEqual({ value: 1 });
        expect(loader).toHaveBeenCalledTimes(1);
    });

    test('invalidate forces reload', async () => {
        const loader = jest.fn()
            .mockResolvedValueOnce('first')
            .mockResolvedValueOnce('second');
        expect(await cache.getOrLoad('k', loader, { ttlMs: 1000 })).toBe('first');
        await cache.invalidate('k');
        expect(await cache.getOrLoad('k', loader, { ttlMs: 1000 })).toBe('second');
    });

    test('invalidatePrefix wipes all matching L1 entries', async () => {
        const loader = jest.fn().mockImplementation((suffix) => async () => `v:${suffix}`);
        await cache.getOrLoad('exit:rule:HOSTELLER_BOYS:1', loader('a'), { ttlMs: 1000 });
        await cache.getOrLoad('exit:rule:DAY_SCHOLAR:2', loader('b'), { ttlMs: 1000 });
        await cache.getOrLoad('other:key', loader('c'), { ttlMs: 1000 });
        await cache.invalidatePrefix('exit:rule:');

        const reloadA = jest.fn().mockResolvedValue('reloaded');
        await cache.getOrLoad('exit:rule:HOSTELLER_BOYS:1', reloadA, { ttlMs: 1000 });
        expect(reloadA).toHaveBeenCalledTimes(1);

        // The unrelated key should still be cached.
        const stillCached = jest.fn().mockResolvedValue('SHOULD_NOT_RUN');
        await cache.getOrLoad('other:key', stillCached, { ttlMs: 1000 });
        expect(stillCached).not.toHaveBeenCalled();
    });

    test('expired entries are reloaded', async () => {
        const loader = jest.fn()
            .mockResolvedValueOnce('first')
            .mockResolvedValueOnce('second');
        expect(await cache.getOrLoad('k', loader, { ttlMs: 1, l1TtlMs: 1 })).toBe('first');
        await new Promise((r) => setTimeout(r, 10));
        expect(await cache.getOrLoad('k', loader, { ttlMs: 1, l1TtlMs: 1 })).toBe('second');
    });

    test('null results are cached briefly (negative cache)', async () => {
        const loader = jest.fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ found: true });
        const first = await cache.getOrLoad('miss', loader, { ttlMs: 1000 });
        const second = await cache.getOrLoad('miss', loader, { ttlMs: 1000 });
        expect(first).toBeNull();
        expect(second).toBeNull();
        expect(loader).toHaveBeenCalledTimes(1);
    });

    test('loader exceptions propagate and are NOT cached', async () => {
        const loader = jest.fn()
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce('ok');
        await expect(cache.getOrLoad('k', loader, { ttlMs: 1000 })).rejects.toThrow('boom');
        await expect(cache.getOrLoad('k', loader, { ttlMs: 1000 })).resolves.toBe('ok');
    });
});
