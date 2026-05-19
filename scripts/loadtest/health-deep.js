// k6 — deep health-check test.
//
// `/health/deep` pings Mongo + Redis + Face AI. It's cheap on a
// healthy system but expensive when something is degraded (timeouts
// fire). Validates that the endpoint stays well under its per-check
// budget even under concurrent monitoring traffic.

import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
    vus: 20,
    duration: '30s',
    thresholds: {
        'http_req_duration{endpoint:health_deep}': ['p(95)<3000'], // 3 dependencies × ~2.5s timeout each, run in parallel.
        'http_req_failed{endpoint:health_deep}': ['rate<0.05'],     // Allow a tiny rate of 503 when redis or face-ai blip.
    },
};

export default function () {
    const res = http.get(`${BASE_URL}/api/v1/health/deep`, {
        tags: { endpoint: 'health_deep' },
    });
    check(res, {
        'health/deep → 200 or 503': (r) => r.status === 200 || r.status === 503,
        'body contains checks': (r) => r.json('checks') !== undefined,
    });
}
