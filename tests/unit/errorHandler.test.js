const { errorHandler, AppError } = require('../../src/middleware/errorHandler');

function makeRes() {
    const res = { headers: {} };
    res.status = jest.fn(function (c) { res.statusCode = c; return res; });
    res.json = jest.fn(function (b) { res.body = b; return res; });
    res.setHeader = jest.fn();
    return res;
}

describe('errorHandler', () => {
    const req = { requestId: 'r1', originalUrl: '/x', method: 'GET' };

    test('maps AppError', () => {
        const res = makeRes();
        errorHandler(new AppError('nope', 418, 'TEAPOT'), req, res, () => {});
        expect(res.statusCode).toBe(418);
        expect(res.body).toMatchObject({ success: false, error: 'nope', code: 'TEAPOT' });
    });

    test('maps Prisma P2002 to 409 DUPLICATE', () => {
        const res = makeRes();
        errorHandler({ code: 'P2002', meta: { target: ['email'] } }, req, res, () => {});
        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('DUPLICATE');
        expect(res.body.error).toMatch(/email/);
    });

    test('maps Prisma P2025 to 404', () => {
        const res = makeRes();
        errorHandler({ code: 'P2025' }, req, res, () => {});
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('NOT_FOUND');
    });

    test('maps JsonWebTokenError to 401', () => {
        const res = makeRes();
        const e = new Error('bad'); e.name = 'JsonWebTokenError';
        errorHandler(e, req, res, () => {});
        expect(res.statusCode).toBe(401);
        expect(res.body.code).toBe('INVALID_TOKEN');
    });

    test('defaults to 500 with generic message', () => {
        const res = makeRes();
        errorHandler(new Error('oops'), req, res, () => {});
        expect(res.statusCode).toBe(500);
        expect(res.body.success).toBe(false);
    });

    test('never leaks stack in production', () => {
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        const res = makeRes();
        errorHandler(new Error('secret'), req, res, () => {});
        expect(res.body.stack).toBeUndefined();
        process.env.NODE_ENV = prev;
    });
});
