// Refresh-token rotation with reuse-revocation. Uses an in-memory fake
// for Redis so the test exercises the real code path including the
// jti -> revoked lookup.

const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;

// In-memory Redis fake — only the commands the service uses.
const fakeStore = new Map();
const fakeRedis = {
    async get(k) { return fakeStore.get(k) ?? null; },
    async set(k, v, _ex, _ttl) { fakeStore.set(k, v); return 'OK'; },
};

jest.mock('../../src/config/redis', () => ({
    getRedis: () => fakeRedis,
    safeCall: async (p) => { try { return await p; } catch { return null; } },
    isRedisUp: () => true,
}));

const svc = require('../../src/services/refreshToken.service');

describe('refreshToken.service', () => {
    const user = {
        id: 'u1',
        email: 'a@b.co',
        role: 'FACULTY',
        department: 'CSE',
        module: null,
        userType: 'COLLEGE_STUDENT',
        appAccess: 'FULL',
    };

    beforeEach(() => fakeStore.clear());

    test('issueTokenPair embeds a jti in the refresh token', () => {
        const { refreshToken, refreshJti } = svc.issueTokenPair(user);
        const decoded = jwt.verify(refreshToken, SECRET);
        expect(decoded.type).toBe('refresh');
        expect(decoded.jti).toBe(refreshJti);
        expect(decoded.jti).toHaveLength(22); // base64url(16 bytes) ≈ 22 chars
    });

    test('rotate returns a new pair and revokes the old jti', async () => {
        const { refreshToken, refreshJti } = svc.issueTokenPair(user);
        const lookup = jest.fn().mockResolvedValue(user);

        const rotated = await svc.rotate(refreshToken, lookup);
        expect(rotated.accessToken).toBeTruthy();
        expect(rotated.refreshToken).not.toBe(refreshToken);

        // Old jti now revoked.
        expect(fakeStore.get(`${svc.REVOKED_PREFIX}${refreshJti}`)).toBe('1');
        expect(lookup).toHaveBeenCalledTimes(1);
    });

    test('reusing an already-rotated refresh token is rejected', async () => {
        const { refreshToken } = svc.issueTokenPair(user);
        const lookup = jest.fn().mockResolvedValue(user);

        // First rotation succeeds.
        await svc.rotate(refreshToken, lookup);
        // Second rotation with the same (now-revoked) token must fail.
        await expect(svc.rotate(refreshToken, lookup)).rejects.toMatchObject({
            statusCode: 401,
            code: 'REFRESH_REVOKED',
        });
    });

    test('rotate rejects an access-typed token', async () => {
        const access = jwt.sign({ id: 'u1', role: 'FACULTY' /* no type:refresh */ }, SECRET, { expiresIn: '5m' });
        await expect(
            svc.rotate(access, async () => user),
        ).rejects.toMatchObject({ statusCode: 401 });
    });

    test('rotate rejects when the user becomes inactive', async () => {
        const { refreshToken } = svc.issueTokenPair(user);
        await expect(
            svc.rotate(refreshToken, async () => null),
        ).rejects.toMatchObject({ statusCode: 401 });
    });

    test('revoke writes the jti to the revocation set', async () => {
        const { refreshToken, refreshJti } = svc.issueTokenPair(user);
        await svc.revoke(refreshToken);
        expect(fakeStore.get(`${svc.REVOKED_PREFIX}${refreshJti}`)).toBe('1');
    });

    test('revoke is a no-op for malformed tokens', async () => {
        await svc.revoke('not-a-jwt');
        expect(fakeStore.size).toBe(0);
    });
});
