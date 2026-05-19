// k6 — gate-scan throughput test.
//
// Drives `/api/v1/scan/verify` with a pool of pre-encrypted QR
// payloads issued from a staging dataset. The script does not
// generate fresh tokens (that would require running AES-GCM in JS
// against the server's secret), so we feed the data file instead.
//
// Data file format: JSON array of objects ─ `{ token: "...", gpsLat, gpsLng, location, scanType }`
// pass via `--env TOKENS_FILE=./tokens.json`.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TOKEN = __ENV.TOKEN || ''; // Operator auth (security guard JWT).

if (!TOKEN) {
    throw new Error('Set TOKEN env var to a valid security-guard access token.');
}

const tokens = new SharedArray('tokens', () => {
    const path = __ENV.TOKENS_FILE || './scripts/loadtest/tokens.sample.json';
    return JSON.parse(open(path));
});

export const options = {
    scenarios: {
        scan_steady_state: {
            executor: 'constant-arrival-rate',
            rate: Number(__ENV.RPS || 60),
            timeUnit: '1s',
            duration: __ENV.DURATION || '2m',
            preAllocatedVUs: 100,
            maxVUs: 300,
        },
    },
    thresholds: {
        'http_req_duration{endpoint:scan_verify}': ['p(95)<800', 'p(99)<1500'],
        'http_req_failed{endpoint:scan_verify,expected_response:true}': ['rate<0.01'],
    },
};

export default function scanScenario() {
    const sample = tokens[Math.floor(Math.random() * tokens.length)];
    const res = http.post(`${BASE_URL}/api/v1/scan/verify`, JSON.stringify(sample), {
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TOKEN}`,
        },
        tags: { endpoint: 'scan_verify' },
    });
    check(res, {
        'verify → 2xx/4xx (no 5xx)': (r) => r.status < 500,
        // Allowed business outcomes — FAKE/DENIED/LIMIT_HIT etc.
        'verify produced a result code': (r) => r.json('data.result') !== undefined || r.status >= 400,
    });
    sleep(0.05);
}
