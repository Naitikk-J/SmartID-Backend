// Verifies the Redis-backed store behaviour with an in-memory fake.

let store;
let mockRedis;
let createRedisStore;

beforeAll(() => {
    store = new Map();
    mockRedis = {
        multi() {
            const queued = [];
            const api = {
                incr(key) {
                    queued.push(() => {
                        const cur = (store.get(key)?.value ?? 0) + 1;
                        const ttl = store.get(key)?.expiresAt ? store.get(key).expiresAt - Date.now() : -1;
                        store.set(key, { value: cur, expiresAt: store.get(key)?.expiresAt ?? 0 });
                        return cur;
                    });
                    return api;
                },
                pttl(key) {
                    queued.push(() => {
                        const e = store.get(key);
                        if (!e || !e.expiresAt) return -1;
                        return Math.max(0, e.expiresAt - Date.now());
                    });
                    return api;
                },
                exec: async () => queued.map((fn) => [null, fn()]),
            };
            return api;
        },
        pexpire: async (key, ttl) => {
            const e = store.get(key) || { value: 0 };
            e.expiresAt = Date.now() + ttl;
            store.set(key, e);
            return 1;
        },
        decr: async (key) => {
            const e = store.get(key);
            if (!e) return 0;
            e.value = Math.max(0, e.value - 1);
            return e.value;
        },
        del: async (key) => { store.delete(key); return 1; },
    };

    jest.doMock('../../src/config/redis', () => ({
        getRedis: () => mockRedis,
        safeCall: async (p) => p,
        isRedisUp: () => true,
        shutdown: async () => {},
    }));

    ({ createRedisStore } = require('../../src/middleware/rateLimit'));
});

afterAll(() => jest.dontMock('../../src/config/redis'));

beforeEach(() => store.clear());

describe('rateLimit Redis store', () => {
    test('increments and sets TTL on first hit', async () => {
        const s = createRedisStore('rl:test', 60_000);
        const r1 = await s.increment('user1');
        expect(r1.totalHits).toBe(1);
        expect(r1.resetTime).toBeInstanceOf(Date);
        const r2 = await s.increment('user1');
        expect(r2.totalHits).toBe(2);
    });

    test('different keys are independent', async () => {
        const s = createRedisStore('rl:test', 60_000);
        await s.increment('a');
        await s.increment('a');
        const rb = await s.increment('b');
        expect(rb.totalHits).toBe(1);
    });

    test('resetKey wipes the counter', async () => {
        const s = createRedisStore('rl:test', 60_000);
        await s.increment('u');
        await s.increment('u');
        await s.resetKey('u');
        const r = await s.increment('u');
        expect(r.totalHits).toBe(1);
    });

    test('fails open (allow) when Redis is down', async () => {
        // Swap out the redis mock to return null.
        jest.resetModules();
        jest.doMock('../../src/config/redis', () => ({
            getRedis: () => null,
            safeCall: async () => null,
            isRedisUp: () => false,
            shutdown: async () => {},
        }));
        const { createRedisStore: csDown } = require('../../src/middleware/rateLimit');
        const s = csDown('rl:test', 60_000);
        const r = await s.increment('x');
        expect(r.totalHits).toBe(1);
    });
});
