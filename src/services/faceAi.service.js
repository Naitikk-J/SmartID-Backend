// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Face AI client
//
// Wraps the Python Face AI microservice with:
//   - request timeout (AbortController)
//   - circuit breaker (fail fast when the service is down)
//
// When the breaker is open, callers receive a real Error with
// `err.code === 'CIRCUIT_OPEN'`. Existing call sites already
// degrade gracefully on Face-AI errors (see scan.routes.js).
// ═══════════════════════════════════════════════════════════════

const config = require('../config/env');
const { CircuitBreaker } = require('../utils/circuitBreaker');

const FACE_AI_URL = config.FACE_AI_URL || 'http://localhost:8001';
const FACE_AI_TIMEOUT_MS = config.FACE_AI_TIMEOUT_MS || 10000;

const breaker = new CircuitBreaker({
    name: 'faceAi',
    threshold: 5,
    windowMs: 30000,
    coolDownMs: 15000,
});

const postJson = async (path, payload) => {
    return breaker.exec(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FACE_AI_TIMEOUT_MS);

        try {
            const response = await fetch(`${FACE_AI_URL}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            const body = await response.json().catch(() => ({}));

            if (!response.ok) {
                const errorMessage = body?.detail || body?.error || `Face AI call failed (${response.status})`;
                const err = new Error(errorMessage);
                err.status = response.status;

                // 4xx are caller errors, not infrastructure failure — don't
                // burn the breaker on them. Force a "success" so the breaker
                // ignores them.
                if (response.status >= 400 && response.status < 500) {
                    breaker.recordSuccess();
                }
                throw err;
            }
            return body;
        } finally {
            clearTimeout(timeout);
        }
    });
};

const healthcheck = async () => {
    const response = await fetch(`${FACE_AI_URL}/health`, { method: 'GET' });
    if (!response.ok) {
        throw new Error('Face AI service healthcheck failed');
    }
    return true;
};

const extractDescriptor = async (imageFrame, streamId = 'default') => {
    return postJson('/extract', { imageFrame, streamId });
};

const extractBatchDescriptor = async (faceImages) => {
    return postJson('/extract-batch', { faceImages });
};

module.exports = {
    healthcheck,
    extractDescriptor,
    extractBatchDescriptor,
    breaker, // exposed for /health and tests
};
