// Tests exit.service.checkExitAllowed with a mocked Prisma and cache.

let mockPrisma;
let exitService;

jest.mock('../../src/config/database', () => {
    const m = {
        campusEvent: { findFirst: jest.fn() },
        exitRule: { findUnique: jest.fn(), upsert: jest.fn() },
        exitEvent: { count: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
        gate: { findFirst: jest.fn() },
        auditLog: { create: jest.fn() },
    };
    return m;
});

// Cache is a thin wrapper around loaders — invoke loader synchronously.
jest.mock('../../src/services/cache.service', () => ({
    getOrLoad: (_key, loader) => loader(),
    invalidate: jest.fn(),
    invalidatePrefix: jest.fn(),
}));

describe('exit.service.checkExitAllowed', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPrisma = require('../../src/config/database');
        exitService = require('../../src/services/exit.service');
        mockPrisma.campusEvent.findFirst.mockResolvedValue(null);
        mockPrisma.exitEvent.count.mockResolvedValue(0);
        mockPrisma.exitRule.findUnique.mockResolvedValue(null);
    });

    test('day scholars bypass exit limits entirely', async () => {
        const r = await exitService.checkExitAllowed({ id: 's1', studentType: 'DAY_SCHOLAR' });
        expect(r.allowed).toBe(true);
        expect(r.mode).toBe('BYPASS');
        expect(mockPrisma.campusEvent.findFirst).not.toHaveBeenCalled();
    });

    test('no rule and no event = allow', async () => {
        const r = await exitService.checkExitAllowed({ id: 's1', studentType: 'HOSTELLER_BOYS' });
        expect(r.allowed).toBe(true);
        expect(r.mode).toBe('NO_RULE');
    });

    test('honours rule and blocks once max reached', async () => {
        mockPrisma.exitRule.findUnique.mockResolvedValue({ maxExits: 2 });
        mockPrisma.exitEvent.count.mockResolvedValue(2);
        const r = await exitService.checkExitAllowed({ id: 's', studentType: 'HOSTELLER_BOYS' });
        expect(r.allowed).toBe(false);
        expect(r.mode).toBe('RULE');
        expect(r.used).toBe(2);
        expect(r.max).toBe(2);
    });

    test('rule of -1 means unlimited', async () => {
        mockPrisma.exitRule.findUnique.mockResolvedValue({ maxExits: -1 });
        const r = await exitService.checkExitAllowed({ id: 's', studentType: 'HOSTELLER_BOYS' });
        expect(r.allowed).toBe(true);
        expect(r.mode).toBe('UNLIMITED');
    });

    test('active UNLIMITED event overrides rule', async () => {
        mockPrisma.campusEvent.findFirst.mockResolvedValue({
            name: 'Tech Fest', exitMode: 'UNLIMITED', appliesTo: ['ALL'], gateIds: [],
        });
        mockPrisma.exitRule.findUnique.mockResolvedValue({ maxExits: 1 });
        mockPrisma.exitEvent.count.mockResolvedValue(5);
        const r = await exitService.checkExitAllowed({ id: 's', studentType: 'HOSTELLER_BOYS' });
        expect(r.allowed).toBe(true);
        expect(r.mode).toBe('UNLIMITED');
        expect(r.reason).toMatch(/Tech Fest/);
    });

    test('SINGLE event mode allows first exit, blocks subsequent', async () => {
        mockPrisma.campusEvent.findFirst.mockResolvedValue({
            name: 'Cricket Final', exitMode: 'SINGLE', appliesTo: ['HOSTELLER_GIRLS'], gateIds: [],
        });
        // Already used once
        mockPrisma.exitEvent.count.mockResolvedValue(1);
        const r = await exitService.checkExitAllowed({ id: 's', studentType: 'HOSTELLER_GIRLS' });
        expect(r.allowed).toBe(false);
        expect(r.mode).toBe('SINGLE');
    });

    test('CUSTOM event mode respects customMax', async () => {
        mockPrisma.campusEvent.findFirst.mockResolvedValue({
            name: 'Marathon', exitMode: 'CUSTOM', customMax: 3, appliesTo: ['ALL'], gateIds: [],
        });
        mockPrisma.exitEvent.count.mockResolvedValue(2);
        const r = await exitService.checkExitAllowed({ id: 's', studentType: 'HOSTELLER_BOYS' });
        expect(r.allowed).toBe(true);
        expect(r.max).toBe(3);
        expect(r.used).toBe(2);
    });
});
