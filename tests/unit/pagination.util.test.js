const { parsePagination, DEFAULT_LIMIT, ABSOLUTE_MAX_LIMIT } = require('../../src/utils/pagination');

describe('parsePagination', () => {
    test('returns defaults for empty query', () => {
        const { page, limit, skip } = parsePagination({});
        expect(page).toBe(1);
        expect(limit).toBe(DEFAULT_LIMIT);
        expect(skip).toBe(0);
    });

    test('coerces string inputs', () => {
        expect(parsePagination({ page: '3', limit: '20' })).toEqual({ page: 3, limit: 20, skip: 40 });
    });

    test('rejects negative / zero / NaN page and limit', () => {
        expect(parsePagination({ page: 0, limit: 0 })).toEqual({ page: 1, limit: DEFAULT_LIMIT, skip: 0 });
        expect(parsePagination({ page: -5, limit: -5 })).toEqual({ page: 1, limit: DEFAULT_LIMIT, skip: 0 });
        expect(parsePagination({ page: 'abc', limit: null })).toEqual({ page: 1, limit: DEFAULT_LIMIT, skip: 0 });
    });

    test('respects custom maxLimit', () => {
        expect(parsePagination({ limit: 5000 }, { maxLimit: 200 }).limit).toBe(200);
    });

    test('never exceeds the absolute ceiling', () => {
        expect(parsePagination({ limit: 99999 }, { maxLimit: 999999 }).limit).toBe(ABSOLUTE_MAX_LIMIT);
    });

    test('clamps absurdly large page numbers', () => {
        const r = parsePagination({ page: 1e15 });
        expect(r.page).toBeLessThanOrEqual(1_000_000);
    });
});
