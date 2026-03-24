const request = require('supertest');
const app = require('../src/app');

const checks = [
    { method: 'post', path: '/api/v1/auth/login', body: { email: 'x@y.com', password: 'x' } },
    { method: 'get', path: '/api/v1/auth/me' },
    { method: 'post', path: '/api/v1/scan/verify', body: { rawToken: 'x', scanType: 'GATE_ENTRY' } },
    { method: 'get', path: '/api/v1/scan/recent' },
    { method: 'get', path: '/api/v1/students' },
    { method: 'get', path: '/api/v1/attendance/defaulters' },
    { method: 'get', path: '/api/v1/gates/exit-rules' },
    { method: 'post', path: '/api/v1/gates/exit-override', body: {} },
    { method: 'get', path: '/api/v1/events' },
    { method: 'get', path: '/api/v1/library/overdue' },
    { method: 'get', path: '/api/v1/elections/test-election-id/results' },
    { method: 'get', path: '/api/v1/reports/campus-occupancy' },
    { method: 'get', path: '/api/v1/admin/users' },
    { method: 'get', path: '/api/v1/access/gates' },
    {
        method: 'post',
        path: '/api/v1/access/scan',
        body: {
            qr_token: 'x',
            event_type: 'ENTRY',
            latitude: 1,
            longitude: 1,
            accuracy: 5,
            timestamp: new Date().toISOString(),
            mock_location: false,
        },
    },
    { method: 'get', path: '/api/v1/qr/generate' },
];

async function run() {
    let has404 = false;
    for (const check of checks) {
        let req = request(app)[check.method](check.path);
        if (check.body) req = req.send(check.body);

        const res = await req;
        const ok = res.status !== 404;
        if (!ok) has404 = true;

        const marker = ok ? 'OK ' : 'ERR';
        console.log(`${marker} ${String(res.status).padStart(3)} ${check.method.toUpperCase()} ${check.path}`);
    }

    if (has404) {
        process.exitCode = 1;
    }
}

run().catch((err) => {
    console.error('Smoke test failed:', err);
    process.exitCode = 1;
});
