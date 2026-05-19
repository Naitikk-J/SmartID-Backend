const crypto = require('crypto');
const cryptoService = require('../../src/services/crypto.service');

describe('crypto.service', () => {
    describe('encryptToken / decryptToken', () => {
        test('round-trips a JSON payload', () => {
            const payload = { studentId: 'abc123', cardId: 'card_456', type: 'STATIC' };
            const token = cryptoService.encryptToken(payload);
            expect(typeof token).toBe('string');
            expect(token.length).toBeGreaterThan(40);
            expect(cryptoService.decryptToken(token)).toEqual(payload);
        });

        test('produces a different ciphertext for the same payload each call (IV uniqueness)', () => {
            const payload = { x: 1 };
            const t1 = cryptoService.encryptToken(payload);
            const t2 = cryptoService.encryptToken(payload);
            expect(t1).not.toBe(t2);
        });

        test('throws on tampered ciphertext (auth tag mismatch)', () => {
            const token = cryptoService.encryptToken({ x: 1 });
            const tampered = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
            expect(() => cryptoService.decryptToken(tampered)).toThrow();
        });

        test('throws on garbage input', () => {
            expect(() => cryptoService.decryptToken('not-a-token')).toThrow();
            expect(() => cryptoService.decryptToken('')).toThrow();
            expect(() => cryptoService.decryptToken(null)).toThrow();
        });

        test('rejects undefined/null payload', () => {
            expect(() => cryptoService.encryptToken(undefined)).toThrow();
            expect(() => cryptoService.encryptToken(null)).toThrow();
        });
    });

    describe('generateCardUid', () => {
        test('returns CRD-prefixed 16-char-ish UID', () => {
            const id = cryptoService.generateCardUid();
            expect(id).toMatch(/^CRD-[0-9A-F]{12}$/);
        });

        test('generates unique values', () => {
            const ids = new Set();
            for (let i = 0; i < 100; i++) ids.add(cryptoService.generateCardUid());
            expect(ids.size).toBe(100);
        });
    });

    describe('hashPassword / verifyPassword', () => {
        test('hash is not the plaintext and verifies correctly', async () => {
            const hash = await cryptoService.hashPassword('hunter2');
            expect(hash).not.toBe('hunter2');
            expect(await cryptoService.verifyPassword('hunter2', hash)).toBe(true);
            expect(await cryptoService.verifyPassword('wrong', hash)).toBe(false);
        });

        test('returns false on missing inputs', async () => {
            expect(await cryptoService.verifyPassword('', 'x')).toBe(false);
            expect(await cryptoService.verifyPassword('x', '')).toBe(false);
        });
    });
});
