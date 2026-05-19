const { bodyLimit, parseLimit } = require('../../src/middleware/bodyLimit');

function mkRes() {
    const res = { headers: {} };
    res.status = jest.fn(function (c) { res.statusCode = c; return res; });
    res.json = jest.fn(function (b) { res.body = b; return res; });
    return res;
}

describe('parseLimit', () => {
    test.each([
        ['64kb', 64 * 1024],
        ['1mb', 1024 * 1024],
        ['512b', 512],
        ['  2 MB  ', 2 * 1024 * 1024],
        [1234, 1234],
        [null, 1024 * 1024],
        ['nonsense', 1024 * 1024],
    ])('parseLimit(%p) -> %p', (input, expected) => {
        expect(parseLimit(input)).toBe(expected);
    });
});

describe('bodyLimit middleware', () => {
    test('passes when content-length is below the limit', () => {
        const next = jest.fn();
        const res = mkRes();
        bodyLimit('1kb')({ headers: { 'content-length': '500' } }, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });

    test('rejects 413 when content-length exceeds the limit', () => {
        const next = jest.fn();
        const res = mkRes();
        bodyLimit('1kb')({ headers: { 'content-length': '2000' } }, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(413);
        expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });

    test('passes when no content-length header is present (streaming)', () => {
        const next = jest.fn();
        const res = mkRes();
        bodyLimit('1kb')({ headers: {} }, res, next);
        expect(next).toHaveBeenCalled();
    });
});
