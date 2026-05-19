const { EventEmitter } = require('events');
const sseHub = require('../../src/sockets/sseHub');

// Stub Express req/res that captures writes for assertion.
function fakeReqRes() {
    const req = new EventEmitter();
    const writes = [];
    const headers = {};
    const res = {
        headers,
        setHeader: (k, v) => { headers[k] = v; },
        flushHeaders: jest.fn(),
        write: (chunk) => { writes.push(chunk.toString()); return true; },
        end: jest.fn(),
        on: jest.fn(),
        _writes: writes,
    };
    return { req, res };
}

beforeEach(() => sseHub._resetForTests());
afterAll(() => sseHub._resetForTests());

describe('sseHub.subscribe', () => {
    test('sets the SSE headers required by EventSource', () => {
        const { req, res } = fakeReqRes();
        sseHub.subscribe(req, res);
        expect(res.headers['Content-Type']).toBe('text/event-stream');
        expect(res.headers['Cache-Control']).toBe('no-cache, no-transform');
        expect(res.headers.Connection).toBe('keep-alive');
        // Nginx-specific: disables proxy buffering so the frames flush
        // immediately rather than batching.
        expect(res.headers['X-Accel-Buffering']).toBe('no');
    });

    test('sends a ready frame on subscribe', () => {
        const { req, res } = fakeReqRes();
        sseHub.subscribe(req, res);
        const ready = res._writes.find((w) => w.startsWith('event: ready'));
        expect(ready).toBeTruthy();
        expect(ready).toMatch(/"ts":/);
    });

    test('removes the subscriber on req close', () => {
        const { req, res } = fakeReqRes();
        sseHub.subscribe(req, res);
        expect(sseHub.size()).toBe(1);
        req.emit('close');
        expect(sseHub.size()).toBe(0);
        expect(res.end).toHaveBeenCalled();
    });
});

describe('sseHub.broadcast', () => {
    test('writes a properly-framed SSE event to every subscriber', () => {
        const a = fakeReqRes(); sseHub.subscribe(a.req, a.res);
        const b = fakeReqRes(); sseHub.subscribe(b.req, b.res);

        sseHub.broadcast('SCAN_EVENT', { id: '1', result: 'VERIFIED' });

        for (const sub of [a, b]) {
            const frame = sub.res._writes.find((w) => w.startsWith('event: SCAN_EVENT'));
            expect(frame).toBeTruthy();
            // Frame ends with the required double-newline.
            expect(frame.endsWith('\n\n')).toBe(true);
            expect(frame).toContain('"id":"1"');
            expect(frame).toContain('"result":"VERIFIED"');
        }
    });

    test('no-op when there are no subscribers', () => {
        expect(() => sseHub.broadcast('SCAN_EVENT', { a: 1 })).not.toThrow();
    });

    test('evicts a subscriber whose socket throws on write', () => {
        const { req, res } = fakeReqRes();
        sseHub.subscribe(req, res);
        // After the initial ready frame, simulate a broken socket.
        res.write = () => { throw new Error('EPIPE'); };
        sseHub.broadcast('SCAN_EVENT', { x: 1 });
        expect(sseHub.size()).toBe(0);
    });
});
