// ═══════════════════════════════════════════════════════════════
// MITS Smart ID — Search sanitization
//
// Prisma's MongoDB connector translates `{ contains: term, mode:
// 'insensitive' }` into `$regex` queries. If `term` contains regex
// metacharacters, an attacker can:
//   1. Match unintended records (e.g. ".*" -> match anything)
//   2. Trigger ReDoS via catastrophic backtracking patterns
//
// `safeContains` returns a regex-escaped, length-capped string
// suitable for direct use as a `contains` filter. Empty/whitespace
// inputs collapse to null so callers can skip the clause entirely.
// ═══════════════════════════════════════════════════════════════

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(input) {
    return String(input).replace(REGEX_META, '\\$&');
}

function safeContains(input, { maxLen = 80 } = {}) {
    if (input === null || input === undefined) return null;
    const trimmed = String(input).trim();
    if (!trimmed) return null;
    const truncated = trimmed.slice(0, Math.max(1, maxLen));
    return escapeRegex(truncated);
}

/**
 * Build a Prisma `OR` clause that searches multiple fields for the
 * same term. Returns null if the input is empty (so the caller can
 * omit the clause without conditional logic at every call site).
 *
 * Example:
 *   const or = orContains(req.query.q, ['fullName', 'enrollmentNo']);
 *   if (or) where.OR = or;
 */
function orContains(input, fields, opts = {}) {
    const term = safeContains(input, opts);
    if (!term) return null;
    return fields.map((field) => ({
        [field]: { contains: term, mode: 'insensitive' },
    }));
}

module.exports = { escapeRegex, safeContains, orContains };
