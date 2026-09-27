'use strict';

/**
 * T4 (2026-09-26) — `require-receipt-trailer: true`: the head commit must CARRY its own receipt.
 *
 * The default gate asks the CodeRifts API for a receipt at run time. With this option on, the gate
 * additionally requires the receipt that was attached to the head commit — a `CodeRifts-Receipt:`
 * trailer or a `.coderifts/receipts/<sha>.json` sidecar (receipt-from-commit.js, vendored from
 * receipt-verifier) — and checks it OFFLINE against the pinned keyring with the vendored verifier.
 *
 * WHAT "THE SAME DIFF" MEANS HERE. A receipt attached to a commit cannot name that commit's SHA: it
 * was minted before the commit existed. What it can name is the change itself. The signed envelope
 * carries `artifact_digest` — sha256 over each contract artifact's before/after bytes, sorted by
 * type and id (coderifts-app src/change-set.js, the same recipe, recomputed here). The gate derives
 * the artifacts from the PR's ACTUAL diff and requires the two digests to be equal.
 *
 * ⚠ THE ENVELOPE IS REQUIRED. The digest lives in the envelope, and the signature binds the
 * envelope through `bh`. A trailer carries only the token, so a trailer-only receipt can prove it is
 * authentic but not which diff it covers — that is a FAILURE (receipt_envelope_required), not a
 * pass on half the evidence. A sidecar can carry the envelope; so can trailer + sidecar together.
 */

const crypto = require('node:crypto');
const { receiptForCommit } = require('./receipt-from-commit');
const { verifyReceipt } = require('./verify');
const { verifyMonitoringAttestation, receiptDigest } = require('./monitoring-attestation');

const US = '\x1f';
const ALLOW_ACTIONS = Object.freeze(['CONTINUE']);

function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function specStr(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** The change-set digest the envelope signs, recomputed from the artifacts of THIS diff. */
function artifactDigestOf(artifacts) {
  return `sha256:${sha256hex(
    artifacts.slice()
      .sort((a, b) => (`${a.type}${US}${a.id}` < `${b.type}${US}${b.id}` ? -1 : 1))
      .map((a) => `${sha256hex(specStr(a.before))}${sha256hex(specStr(a.after))}`)
      .join(US),
  )}`;
}

/**
 * Judge a receipt the gate already holds. The pass is the offline verify plus the binding,
 * never a decision string that arrived next to the token.
 *
 * `profile: 'enforcing'` is the reader. It names the closed reasons the reader posts
 * (INVALID_SIGNATURE, VERIFIED_EXPIRED, target_mismatch, operation_mismatch) and it allows
 * CONTINUE_WITH_MONITORING only when the monitoring attestation verifies. The legacy caller
 * keeps the 2026-09-26 reason strings.
 */
function judgeReceipt({
  token, envelope, carrier = null, keyring, artifacts, now,
  profile = null,
  requireVerifiedMonitoring = false,
  monitoringAttestation = null,
  monitoringKeyring = null,
}) {
  const enforcing = profile === 'enforcing';
  if (!envelope || typeof envelope !== 'object') {
    return {
      ok: false,
      reason: 'receipt_envelope_required',
      carrier,
      token: token || null,
      detail: 'the attached receipt carries no envelope, so the diff it covers cannot be checked; '
        + 'attach .coderifts/receipts/<sha>.json with { receipt, envelope }',
    };
  }
  const res = verifyReceipt(token, { ctx: { keyring, expectedKid: null }, envelope, now });
  if (!res || res.valid !== true) {
    const status = res && res.status;
    if (enforcing && (status === 'INVALID_SIGNATURE' || status === 'VERIFIED_EXPIRED')) {
      return { ok: false, reason: status, carrier, status, token, envelope, payload: res && res.payload };
    }
    return { ok: false, reason: 'receipt_trailer_invalid', carrier, status, token, envelope, payload: res && res.payload };
  }
  const want = artifactDigestOf(artifacts);
  const hasTarget = typeof envelope.target_id === 'string' && envelope.target_id.length > 0;
  const signedTarget = hasTarget ? envelope.target_id : envelope.artifact_digest;
  const targetAgrees = !hasTarget || !envelope.artifact_digest || envelope.artifact_digest === envelope.target_id;
  if (!targetAgrees || signedTarget !== want) {
    return {
      ok: false,
      reason: enforcing ? 'target_mismatch' : 'receipt_diff_mismatch',
      carrier,
      token,
      envelope,
      payload: res.payload,
      detail: `receipt covers ${signedTarget || '(none)'}, this diff is ${want}`,
    };
  }
  if (enforcing && envelope.operation !== 'merge') {
    return {
      ok: false, reason: 'operation_mismatch', carrier, status: envelope.operation || null,
      token, envelope, payload: res.payload,
    };
  }
  const action = envelope.execution_action;
  if (enforcing && action === 'CONTINUE_WITH_MONITORING') {
    if (requireVerifiedMonitoring !== true || !monitoringKeyring) {
      return {
        ok: false, reason: 'monitoring_keyring_missing', carrier, status: action,
        token, envelope, payload: res.payload,
      };
    }
    const mon = verifyMonitoringAttestation(String(monitoringAttestation || ''), {
      registry: monitoringKeyring,
      intended: {
        decision_id: typeof envelope.decision_id === 'string' ? envelope.decision_id : '',
        receipt_digest: receiptDigest(token),
      },
      now,
    });
    const monOk = mon && (mon.status === 'MON_ATTEST_VALID' || mon.status === 'MON_ATTEST_RETIRED_KEY_VALID_AT_ISSUE');
    if (!monOk || !mon.payload || mon.payload.delivery_status !== 'delivered_acked') {
      return {
        ok: false, reason: 'monitoring_not_verified', carrier, status: mon && mon.status,
        token, envelope, payload: res.payload,
      };
    }
  } else if (!ALLOW_ACTIONS.includes(action)) {
    return {
      ok: false, reason: 'receipt_not_allow', carrier, status: action || null,
      token, envelope, payload: res.payload,
    };
  }
  return {
    ok: true, reason: 'receipt_trailer_verified', carrier, status: res.status,
    token, envelope, payload: res.payload,
  };
}

/**
 * @param {object} o
 * @param {string} o.headSha
 * @param {string} o.cwd            repository checkout
 * @param {object} o.keyring        the pinned keyring (loadKeyring)
 * @param {Array}  o.artifacts      deriveArtifactsFromDiff(...).artifacts
 * @returns {{ ok: boolean, reason: string, carrier?: string, status?: string, detail?: string }}
 */
function checkReceiptTrailer({
  headSha, cwd, keyring, artifacts, now, findImpl = receiptForCommit,
  profile = null, requireVerifiedMonitoring = false, monitoringAttestation = null, monitoringKeyring = null,
}) {
  let found;
  try {
    found = findImpl(headSha, { cwd });
  } catch (err) {
    const msg = String((err && err.message) || err);
    const reason = /conflict/.test(msg) ? 'receipt_trailer_conflict'
      : /not valid JSON|has no "receipt"/.test(msg) ? 'receipt_sidecar_invalid'
        : 'receipt_trailer_missing';
    return { ok: false, reason, detail: msg.slice(0, 300) };
  }
  return judgeReceipt({
    token: found.token, envelope: found.envelope, carrier: found.carrier, keyring, artifacts, now,
    profile, requireVerifiedMonitoring, monitoringAttestation, monitoringKeyring,
  });
}

module.exports = { checkReceiptTrailer, judgeReceipt, artifactDigestOf };
