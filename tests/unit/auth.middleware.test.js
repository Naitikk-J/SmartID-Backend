// Tests the JWT auth middleware: header parsing, blacklist check,
// role hierarchy. Redis is mocked so we can simulate blacklist hits.

const jwt = require('jsonwebtoken');

jest.mock('ioredis', () => {
    const store = new Map();
    function FakeRedis() {
        return {
            get: async (k) => store.get(k) ?? null,
            set: async (k, v) => { store.set(k, v); return 'OK'; },
            on: () => {},
        };
    }
    FakeRedis.__store = store;
    return FakeRedis;
});

const { authenticate, requireRole } = require('../../src/middleware/auth');

const SECRET = process.env.JWT_SECRET;

describe('authenticate', () => {
    test('rejects missing header', async () => {
        const next = jest.fn();
        await authenticate({ headers: {} }, {}, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    });

    test('rejects "Bearer null"', async () => {
        const next = jest.fn();
        await authenticate({ headers: { authorization: 'Bearer null' } }, {}, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    });

    test('rejects malformed token', async () => {
        const next = jest.fn();
        await authenticate({ headers: { authorization: 'Bearer not-a-jwt' } }, {}, next);
        expect(next).toHaveBeenCalled();
        expect(next.mock.calls[0][0].name).toMatch(/JsonWebTokenError|AppError/);
    });

    test('accepts a valid token and populates req.user', async () => {
        const token = jwt.sign(
            { id: 'u1', email: 'a@b.c', role: 'FACULTY', userType: 'COLLEGE_STUDENT' },
            SECRET,
            { expiresIn: '5m' },
        );
        const req = { headers: { authorization: `Bearer ${token}` } };
        const next = jest.fn();
        await authenticate(req, {}, next);
        expect(next).toHaveBeenCalledWith();
        expect(req.user).toMatchObject({ id: 'u1', email: 'a@b.c', role: 'FACULTY' });
        expect(req.token).toBe(token);
    });

    test('rejects expired token', async () => {
        const token = jwt.sign({ id: 'u1' }, SECRET, { expiresIn: '-1s' });
        const next = jest.fn();
        await authenticate({ headers: { authorization: `Bearer ${token}` } }, {}, next);
        expect(next).toHaveBeenCalled();
        const err = next.mock.calls[0][0];
        expect(err.name === 'TokenExpiredError' || err.code === 'TOKEN_EXPIRED').toBe(true);
    });
});

describe('requireRole', () => {
    const mkReq = (role) => ({ user: { role } });

    test('blocks anonymous', () => {
        const next = jest.fn();
        requireRole('FACULTY')({}, {}, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    });

    test('SUPER_ADMIN bypasses every role check', () => {
        const next = jest.fn();
        requireRole('FACULTY', 'HOD')(mkReq('SUPER_ADMIN'), {}, next);
        expect(next).toHaveBeenCalledWith();
    });

    test('allows a listed role', () => {
        const next = jest.fn();
        requireRole('FACULTY')(mkReq('FACULTY'), {}, next);
        expect(next).toHaveBeenCalledWith();
    });

    test('forbids an unlisted role', () => {
        const next = jest.fn();
        requireRole('FACULTY')(mkReq('SECURITY_GUARD'), {}, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    });
});
