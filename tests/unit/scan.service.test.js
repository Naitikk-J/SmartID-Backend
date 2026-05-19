// Pure-function tests for scan.service helpers — no DB, no Redis.

describe('scan.service helpers', () => {
    let scan;
    beforeAll(() => {
        // Make sure config doesn't try to crash on missing AES_KEY.
        process.env.AES_KEY = 'REDACTED';
        scan = require('../../src/services/scan.service');
    });

    describe('haversineDistance', () => {
        test('returns ~0 for identical points', () => {
            expect(scan.haversineDistance(26.2183, 78.1828, 26.2183, 78.1828)).toBeLessThan(1);
        });

        test('measures Gwalior → Delhi (~289km) within 5% accuracy', () => {
            // Gwalior 26.2183,78.1828 → Delhi 28.6139,77.2090 ≈ 289 km
            const d = scan.haversineDistance(26.2183, 78.1828, 28.6139, 77.2090);
            expect(d).toBeGreaterThan(280_000);
            expect(d).toBeLessThan(310_000);
        });
    });

    describe('checkGeofence', () => {
        test('inside the radius', () => {
            const { inside, distance } = scan.checkGeofence(26.2183, 78.1828, 26.2183, 78.1828, 100);
            expect(inside).toBe(true);
            expect(distance).toBeLessThan(2);
        });

        test('outside the radius', () => {
            const r = scan.checkGeofence(26.5183, 78.1828, 26.2183, 78.1828, 500);
            expect(r.inside).toBe(false);
            expect(r.distance).toBeGreaterThan(500);
        });

        test('refuses to allow when GPS is missing', () => {
            const r = scan.checkGeofence(null, null, 26.2183, 78.1828, 500);
            expect(r.inside).toBe(false);
            expect(r.reason).toMatch(/GPS/);
        });
    });

    describe('resolveMealSlot', () => {
        const mkDate = (hour, min = 0) => {
            const d = new Date();
            d.setHours(hour, min, 0, 0);
            return d;
        };

        test('BREAKFAST 06–10', () => {
            expect(scan.resolveMealSlot(mkDate(7)).slot).toBe('BREAKFAST');
            expect(scan.resolveMealSlot(mkDate(9, 59)).slot).toBe('BREAKFAST');
            expect(scan.resolveMealSlot(mkDate(10)).slot).not.toBe('BREAKFAST');
        });

        test('LUNCH 11–15', () => {
            expect(scan.resolveMealSlot(mkDate(12)).slot).toBe('LUNCH');
            expect(scan.resolveMealSlot(mkDate(14, 59)).slot).toBe('LUNCH');
        });

        test('SNACKS 16–17', () => {
            expect(scan.resolveMealSlot(mkDate(16, 30)).slot).toBe('SNACKS');
        });

        test('DINNER 18–22', () => {
            expect(scan.resolveMealSlot(mkDate(20)).slot).toBe('DINNER');
        });

        test('OTHER for 0–5, 10, 15, 17, 22–23', () => {
            expect(scan.resolveMealSlot(mkDate(3)).slot).toBe('OTHER');
            expect(scan.resolveMealSlot(mkDate(10)).slot).toBe('OTHER');
            expect(scan.resolveMealSlot(mkDate(15)).slot).toBe('OTHER');
            expect(scan.resolveMealSlot(mkDate(17)).slot).toBe('OTHER');
            expect(scan.resolveMealSlot(mkDate(23)).slot).toBe('OTHER');
        });

        test('window bounds match the slot', () => {
            const { start, end } = scan.resolveMealSlot(mkDate(12));
            expect(start.getHours()).toBe(11);
            expect(end.getHours()).toBe(15);
        });
    });

    describe('buildResult', () => {
        test('maps VERIFIED to GREEN', () => {
            const r = scan.buildResult('VERIFIED', { id: '1', fullName: 'A', enrollmentNo: 'E1' }, { id: 'se1', scannedAt: new Date() });
            expect(r.badge).toBe('GREEN');
            expect(r.student.fullName).toBe('A');
        });

        test('maps FAKE to RED with null student', () => {
            const r = scan.buildResult('FAKE', null, null);
            expect(r.badge).toBe('RED');
            expect(r.student).toBeNull();
        });

        test('treats REENTERED_n as GREEN', () => {
            const r = scan.buildResult('REENTERED_2', { id: 'x' }, null);
            expect(r.badge).toBe('GREEN');
        });
    });
});
