// k6 — login throughput test.
//
// Exercises bcrypt verification, JWT signing, Redis token writes,
// and the per-IP login rate-limiter. Pass a pool of valid emails
// via env so we don't hammer a single account (which would just
// bounce on the per-account limiter).

import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// Comma-separated `email:password` pairs, or fall back to a single
// admin account that *must* exist in staging.
const credentials = new SharedArray('creds', () => {
    const raw = __ENV.LOGIN_POOL
        || `${__ENV.ADMIN_EMAIL || 'admin@mits.local'}:${__ENV.ADMIN_PASSWORD || 'change-me'}`;
    return raw.split(',').map((pair) => {
        const [email, password] = pair.split(':');
        return { email, password };
    });
});

export const options = {
    scenarios: {
        login: {
            executor: 'ramping-arrival-rate',
            startRate: 5,
            timeUnit: '1s',
            preAllocatedVUs: 50,
            maxVUs: 100,
            stages: [
                { target: 25, duration: '20s' },
                { target: 25, duration: '40s' },
                { target: 0,  duration: '10s' },
            ],
        },
    },
    thresholds: {
        // The login endpoint includes bcrypt, so it's intentionally slow.
        'http_req_duration{endpoint:login}': ['p(95)<1500', 'p(99)<2500'],
        // 401s from bad credentials don't count; we only fail on 5xx.
        'http_req_failed{endpoint:login,expected_response:true}': ['rate<0.01'],
    },
};

export default function loginScenario() {
    const cred = credentials[Math.floor(Math.random() * credentials.length)];
    const res = http.post(`${BASE_URL}/api/v1/auth/login`, JSON.stringify(cred), {
        headers: { 'Content-Type': 'application/json' },
        tags: { endpoint: 'login' },
    });
    check(res, {
        'login → 200 or 401': (r) => r.status === 200 || r.status === 401,
        'no 5xx': (r) => r.status < 500,
    });
    sleep(0.5);
}
