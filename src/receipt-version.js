'use strict';

/**
 * P66 (2026-10-12) — the gate accepts only a v4 receipt bound to its envelope, with a readable expiry.
 *
 * MEASURED before (audit probe p1, a test key, 0.11.8): a legitimately signed v1 / v2 / v3 token beside a
 * hand-written sidecar envelope was `signed_allow_for_diff` with no preflight call: v<4 binds no envelope
 * and carries no expiry (the vendored verifier binds and expires v4 only). A v4 whose expires_at is not a
 * string skipped the expiry check too. The CodeRifts app signed v2 tokens for anonymous callers (POST
 * /v1/verdict, measured live 2026-10-12T07:40:35Z).
 *
 * The vendored core (src/verify.js, byte-identical to receipt-verifier) stays untouched; this check runs on
 * its result, on every gate path (issued, sidecar, trailer).
 *
 * @param {{ valid?: boolean, payload?: object }|null} result  verifyReceipt(...) output
 * @param {object|null} envelope  the envelope the receipt was verified against
 * @returns {null | { status: string, reason: string, version: * }}
 */
function v4BoundFault(result, envelope) {
  const p = result && result.payload;
  if (!p || typeof p !== 'object') return null; // structure / signature failures keep their own reason
  if (p.v !== 4) return { status: 'UNSUPPORTED_VERSION', reason: 'receipt_version_unsupported', version: p.v == null ? null : p.v };
  if (!envelope || typeof envelope !== 'object') return { status: 'MALFORMED', reason: 'envelope_missing', version: 4 };
  if (typeof p.expires_at !== 'string' || !Number.isFinite(Date.parse(p.expires_at))) {
    return { status: 'MALFORMED', reason: 'expires_at_unreadable', version: 4 };
  }
  if (typeof p.bh !== 'string' || !p.bh) return { status: 'MALFORMED', reason: 'body_hash_missing', version: 4 };
  return null;
}

module.exports = { v4BoundFault };
