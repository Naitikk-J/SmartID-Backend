const { z } = require('zod');
const { validate, validateQuery } = require('../../src/middleware/validate');

describe('validate(schema)', () => {
    const schema = z.object({ email: z.string().email(), age: z.coerce.number().int().min(0) });

    test('passes valid body', () => {
        const next = jest.fn();
        const req = { body: { email: 'a@b.co', age: '21' } };
        validate(schema)(req, {}, next);
        expect(next).toHaveBeenCalledWith();
        expect(req.body.age).toBe(21);
    });

    test('rejects invalid body with a 400 AppError', () => {
        const next = jest.fn();
        const req = { body: { email: 'nope', age: -1 } };
        validate(schema)(req, {}, next);
        expect(next).toHaveBeenCalled();
        const err = next.mock.calls[0][0];
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('VALIDATION_ERROR');
    });
});

describe('validateQuery(schema)', () => {
    const schema = z.object({ page: z.coerce.number().int().positive().default(1) });

    test('coerces and defaults', () => {
        const next = jest.fn();
        const req = { query: {} };
        validateQuery(schema)(req, {}, next);
        expect(next).toHaveBeenCalledWith();
        expect(req.query.page).toBe(1);
    });

    test('rejects malformed query', () => {
        const next = jest.fn();
        const req = { query: { page: 'banana' } };
        validateQuery(schema)(req, {}, next);
        expect(next.mock.calls[0][0].statusCode).toBe(400);
    });
});
