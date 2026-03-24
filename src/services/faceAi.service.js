const config = require('../config/env');

const FACE_AI_URL = config.FACE_AI_URL || 'http://localhost:8001';
const FACE_AI_TIMEOUT_MS = config.FACE_AI_TIMEOUT_MS || 10000;

const postJson = async (path, payload) => {
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
            throw err;
        }

        return body;
    } finally {
        clearTimeout(timeout);
    }
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
};
