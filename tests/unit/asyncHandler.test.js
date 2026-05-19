const { asyncHandler } = require('../../src/middleware/asyncHandler');

describe('asyncHandler', () => {
    test('forwards async errors to next()', async () => {
        const next = jest.fn();
        const handler = asyncHandler(async () => { throw new Error('boom'); });
        await handler({}, {}, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
        expect(next.mock.calls[0][0].message).toBe('boom');
    });

    test('forwards sync errors to next()', () => {
        const next = jest.fn();
        const handler = asyncHandler(() => { throw new Error('sync'); });
        handler({}, {}, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'sync' }));
    });

    test('does NOT call next on a successful resolution', async () => {
        const next = jest.fn();
        const handler = asyncHandler(async (_req, res) => { res.ok = true; });
        const res = {};
        await handler({}, res, next);
        expect(res.ok).toBe(true);
        expect(next).not.toHaveBeenCalled();
    });
});
