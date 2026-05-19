const { CircuitBreaker } = require('../../src/utils/circuitBreaker');

describe('CircuitBreaker', () => {
    test('starts CLOSED and allows calls', async () => {
        const cb = new CircuitBreaker({ name: 't', threshold: 2 });
        await expect(cb.exec(async () => 'ok')).resolves.toBe('ok');
        expect(cb.snapshot().state).toBe('CLOSED');
    });

    test('opens after threshold failures', async () => {
        const cb = new CircuitBreaker({ name: 't', threshold: 2 });
        await expect(cb.exec(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        await expect(cb.exec(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(cb.snapshot().state).toBe('OPEN');

        // Subsequent calls short-circuit
        await expect(cb.exec(async () => 'ok')).rejects.toThrow(/Circuit 't' is open/);
    });

    test('moves to HALF_OPEN after cooldown and closes on success', async () => {
        const cb = new CircuitBreaker({ name: 't', threshold: 1, coolDownMs: 10 });
        await expect(cb.exec(async () => { throw new Error('boom'); })).rejects.toThrow();
        expect(cb.snapshot().state).toBe('OPEN');

        await new Promise((r) => setTimeout(r, 20));
        await expect(cb.exec(async () => 'ok')).resolves.toBe('ok');
        expect(cb.snapshot().state).toBe('CLOSED');
    });

    test('opens again if the half-open probe fails', async () => {
        const cb = new CircuitBreaker({ name: 't', threshold: 1, coolDownMs: 10 });
        await cb.exec(async () => { throw new Error('boom'); }).catch(() => null);
        await new Promise((r) => setTimeout(r, 20));
        await cb.exec(async () => { throw new Error('still bad'); }).catch(() => null);
        expect(cb.snapshot().state).toBe('OPEN');
    });

    test('fallback receives the error and value is returned instead of throwing', async () => {
        const cb = new CircuitBreaker({ name: 't', threshold: 1 });
        const result = await cb.exec(
            async () => { throw new Error('nope'); },
            (err) => `fallback:${err.message}`,
        );
        expect(result).toBe('fallback:nope');
    });
});
