// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Server-Sent Events hub
//
// A lightweight, transport-only broadcast layer that mirrors the
// Socket.IO scan feed. It exists for two reasons:
//
//   1. Serverless platforms (Vercel) cannot host long-lived
//      WebSocket upgrades; SSE is plain HTTP and reconnects
//      automatically when the function recycles.
//   2. Operators who don't want to run a sticky-session WebSocket
//      tier behind their load balancer can still get a live feed.
//
// The hub is intentionally tiny: it keeps a Set of active Express
// `res` objects, writes `text/event-stream` frames, ships a 25s
// heartbeat (so middleboxes don't kill idle connections), and
// removes clients on close.
//
// Concurrency: a single instance per process. Backpressure isn't
// addressed (admin dashboards are low-volume); if a downstream is
// slow, `res.write` will buffer in libuv as usual.
// ═══════════════════════════════════════════════════════════════

const logger = require('../config/logger');

const HEARTBEAT_MS = 25_000;

const clients = new Set();
let heartbeat = null;

function startHeartbeatIfNeeded() {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
        for (const res of clients) {
            try {
                // SSE comment frame — never reaches the EventSource
                // `onmessage`, but keeps the TCP / proxy timers alive.
                res.write(': hb\n\n');
            } catch (err) {
                // The next write attempt will hit the same socket and
                // trigger the close handler; just log and move on.
                logger.debug?.('SSE heartbeat write failed', { message: err?.message });
            }
        }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
}

function stopHeartbeatIfIdle() {
    if (heartbeat && clients.size === 0) {
        clearInterval(heartbeat);
        heartbeat = null;
    }
}

/**
 * Register an Express response as an SSE subscriber. Returns a
 * disposer the caller can use to remove the subscriber early.
 */
function subscribe(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx proxy buffering
    res.flushHeaders?.();

    // Send a "hello" with the server time so the client can sync
    // its `since` cursor for any polling fallback.
    res.write(`event: ready\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);

    clients.add(res);
    startHeartbeatIfNeeded();

    const cleanup = () => {
        if (clients.delete(res)) {
            try { res.end(); } catch { /* ignore */ }
            stopHeartbeatIfIdle();
        }
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);

    return cleanup;
}

/**
 * Broadcast a named event with a JSON payload to every active
 * subscriber. Failures on individual sockets evict that subscriber
 * but never throw to the caller.
 */
function broadcast(eventName, payload) {
    if (clients.size === 0) return;
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of clients) {
        try {
            res.write(frame);
        } catch (err) {
            clients.delete(res);
            try { res.end(); } catch { /* ignore */ }
        }
    }
    stopHeartbeatIfIdle();
}

function size() {
    return clients.size;
}

function _resetForTests() {
    for (const res of clients) {
        try { res.end(); } catch { /* ignore */ }
    }
    clients.clear();
    if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
    }
}

module.exports = { subscribe, broadcast, size, _resetForTests };
