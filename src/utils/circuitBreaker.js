// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Tiny Circuit Breaker
//
// Wraps a flaky external call (e.g. Face AI). After `threshold`
// consecutive failures within `windowMs`, the breaker opens and
// short-circuits subsequent calls for `coolDownMs`. After cooldown,
// a single probe is allowed (HALF_OPEN).
// ═══════════════════════════════════════════════════════════════

const STATE = Object.freeze({
    CLOSED: 'CLOSED',
    OPEN: 'OPEN',
    HALF_OPEN: 'HALF_OPEN',
});

class CircuitBreaker {
    constructor({ name = 'breaker', threshold = 5, windowMs = 30000, coolDownMs = 15000 } = {}) {
        this.name = name;
        this.threshold = Math.max(1, threshold);
        this.windowMs = Math.max(1, windowMs);
        this.coolDownMs = Math.max(1, coolDownMs);

        this.state = STATE.CLOSED;
        this.failures = []; // timestamps
        this.openedAt = 0;
    }

    _trim(now) {
        const cutoff = now - this.windowMs;
        while (this.failures.length && this.failures[0] < cutoff) this.failures.shift();
    }

    canRequest() {
        const now = Date.now();
        if (this.state === STATE.OPEN) {
            if (now - this.openedAt >= this.coolDownMs) {
                this.state = STATE.HALF_OPEN;
                return true;
            }
            return false;
        }
        return true;
    }

    recordSuccess() {
        this.failures.length = 0;
        this.state = STATE.CLOSED;
        this.openedAt = 0;
    }

    recordFailure() {
        const now = Date.now();
        this.failures.push(now);
        this._trim(now);

        if (this.state === STATE.HALF_OPEN) {
            this.state = STATE.OPEN;
            this.openedAt = now;
            return;
        }
        if (this.failures.length >= this.threshold) {
            this.state = STATE.OPEN;
            this.openedAt = now;
        }
    }

    /**
     * Run `fn`. If breaker is open, calls `fallback(err)` instead.
     * `fn` and `fallback` may be async.
     */
    async exec(fn, fallback) {
        if (!this.canRequest()) {
            const err = new Error(`Circuit '${this.name}' is open`);
            err.code = 'CIRCUIT_OPEN';
            if (fallback) return fallback(err);
            throw err;
        }
        try {
            const value = await fn();
            this.recordSuccess();
            return value;
        } catch (err) {
            this.recordFailure();
            if (fallback) return fallback(err);
            throw err;
        }
    }

    snapshot() {
        return {
            name: this.name,
            state: this.state,
            failures: this.failures.length,
            threshold: this.threshold,
            openedAt: this.openedAt,
        };
    }
}

CircuitBreaker.STATE = STATE;

module.exports = { CircuitBreaker };
