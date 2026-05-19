// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Pagination guard
//
// Centralised parser that:
//   - coerces strings → integers
//   - rejects negative / zero / NaN
//   - clamps to a sane maximum (defaults to 100; some endpoints
//     can raise it via `maxLimit`)
//
// Returns `{ page, limit, skip }` — never throws. This stops
// clients from requesting 1M-row pages and DoSing the DB.
// ═══════════════════════════════════════════════════════════════

const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_LIMIT = 100;
const ABSOLUTE_MAX_LIMIT = 500; // Hard ceiling even when callers raise the cap.

function parsePagination(query = {}, {
    defaultLimit = DEFAULT_LIMIT,
    maxLimit = DEFAULT_MAX_LIMIT,
} = {}) {
    const cap = Math.min(ABSOLUTE_MAX_LIMIT, Math.max(1, maxLimit));

    let page = Number.parseInt(query.page, 10);
    if (!Number.isFinite(page) || page < 1) page = 1;
    if (page > 1_000_000) page = 1_000_000; // Prevent integer-overflow style abuse.

    let limit = Number.parseInt(query.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = defaultLimit;
    if (limit > cap) limit = cap;

    return { page, limit, skip: (page - 1) * limit };
}

module.exports = { parsePagination, DEFAULT_LIMIT, DEFAULT_MAX_LIMIT, ABSOLUTE_MAX_LIMIT };
