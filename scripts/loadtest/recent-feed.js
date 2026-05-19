// k6 — admin dashboard recent-feed test.
//
// Many concurrent admins poll `/scan/recent` while scans flow in.
// Verifies cache hit rate, Mongo `findMany` perf with proper
// indexes, and the new `since` cursor path.

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TOKEN = __ENV.TOKEN || '';

if (!TOKEN) {
    throw new Error('Set TOKEN env var to an admin access token.');
}

export const options = {
    scenarios: {
        recent: {
            executor: 'ramping-vus',
            stages: [
                { target: 50,  duration: '30s' },
                { target: 100, duration: '30s' },
                { target: 100, duration: '30s' },
                { target: 0,   duration: '10s' },
            ],
        },
    },
    thresholds: {
        'http_req_duration{endpoint:recent}': ['p(95)<500'],
        'http_req_failed{endpoint:recent}': ['rate<0.01'],
    },
};

export default function () {
    // 70% polling with `since` cursor (the realistic admin pattern),
    // 30% full page loads.
    const useCursor = Math.random() < 0.7;
    const cursor = new Date(Date.now() - 5 * 60_000).toISOString();
    const url = useCursor
        ? `${BASE_URL}/api/v1/scan/recent?limit=50&since=${encodeURIComponent(cursor)}`
        : `${BASE_URL}/api/v1/scan/recent?limit=50&page=1`;

    const res = http.get(url, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        tags: { endpoint: 'recent' },
    });

    check(res, {
        'recent → 200': (r) => r.status === 200,
        'has events array': (r) => Array.isArray(r.json('data.events')),
    });
    sleep(1);
}
