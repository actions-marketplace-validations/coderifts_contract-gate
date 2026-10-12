'use strict';

/*
 * P66 (2026-10-12) — the gate accepts only a v4 receipt bound to its envelope.
 *
 * MEASURED before (audit probe p1, a test key, 0.11.8): a legitimately signed v1 / v2 / v3 token with a
 * hand-written sidecar `.coderifts/receipts/<head>.json` envelope → exit 0, signed_allow_for_diff, no
 * preflight call. v<4 binds no envelope and carries no expiry (verify.js step 6 and the expiry check are
 * v4-only), and the CodeRifts app signed v2 tokens for anonymous callers (POST /v1/verdict, measured
 * live 2026-10-12T07:40:35Z). The sidecar is written by an earlier workflow step (README), which PR
 * code can be.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runGate } = require('../src/index');
const { deriveArtifactsFromDiff } = require('../src/artifacts');
const { artifactDigestOf } = require('../src/receipt-trailer');
const { verifyReceipt, canonicalJson, sha256hex } = require('../src/verify');

const b64 = (b) => Buffer.from(b).toString('base64url');
function signer(kid = 'test-k1') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { kid, privateKey, pem: publicKey.export({ type: 'spki', format: 'pem' }) };
}
function keyringFile(s, dir) {
  const f = path.join(dir, 'keys.json');
  fs.writeFileSync(f, JSON.stringify({ keys: [{ kid: s.kid, status: 'active', public_key_pem: s.pem }] }));
  return f;
}
const bodyHash = (env) => { const r = { ...env }; delete r.receipt; delete r.decision_body_hash; return 'sha256:' + sha256hex(canonicalJson(r)); };
function mintLegacy(s, v) {
  const p = { v, kid: s.kid, fp: 'sha256:' + 'a'.repeat(64), prev: 'null', caller: 'anon', ts: '2026-10-01T00:00:00.000Z' };
  let input = `crchain.v1|${p.kid}|${p.fp}|${p.prev}|${p.caller}|${p.ts}`;
  if (v >= 2) { p.reg = 'r'.repeat(64); input += `|${p.reg}`; }
  if (v >= 3) { p.ir = 'sha256:' + 'b'.repeat(64); input += `|${p.ir}`; }
  return `${b64(JSON.stringify(p))}.${b64(crypto.sign(null, Buffer.from(input, 'utf8'), s.privateKey))}`;
}
function mintV4(s, env, expiresAt) {
  const p = { v: 4, kid: s.kid, fp: 'sha256:' + 'a'.repeat(64), prev: 'null', caller: 'api', ts: '2026-10-01T00:00:00.000Z', reg: '', ir: '', expires_at: expiresAt, bh: bodyHash(env) };
  const input = `crchain.v1|${p.kid}|${p.fp}|${p.prev}|${p.caller}|${p.ts}|${p.reg}|${p.ir}|${p.expires_at}|${p.bh}`;
  return `${b64(JSON.stringify(p))}.${b64(crypto.sign(null, Buffer.from(input, 'utf8'), s.privateKey))}`;
}
function git(dir, ...a) { return execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p66-'));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'openapi.yaml'), 'openapi: 3.0.0\npaths:\n  /a: {}\n');
  git(dir, 'add', 'openapi.yaml'); git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'openapi.yaml'), 'openapi: 3.0.0\npaths: {}\n'); // a breaking removal
  git(dir, 'add', 'openapi.yaml'); git(dir, 'commit', '-qm', 'head');
  return { dir, base, head: git(dir, 'rev-parse', 'HEAD') };
}

async function gateWithSidecar(tokenFor) {
  const s = signer();
  const r = repo();
  const keyringPath = keyringFile(s, r.dir);
  const { artifacts } = deriveArtifactsFromDiff({ baseRef: r.base, headRef: r.head, cwd: r.dir });
  const envelope = { execution_action: 'CONTINUE', operation: 'merge', preflight_mode: 'authorize', target_id: artifactDigestOf(artifacts), repository: null, base: null, head: null, decision_id: 'forged' };
  fs.mkdirSync(path.join(r.dir, '.coderifts/receipts'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, '.coderifts/receipts', `${r.head}.json`), JSON.stringify({ receipt: tokenFor(s, envelope), envelope }));
  let called = false;
  const res = await runGate({
    apiKey: '', apiUrl: 'http://stub.invalid', githubToken: '', owner: 'o', repo: 'r', baseSha: r.base, headSha: r.head, cwd: r.dir,
    keyringPath, profile: 'enforcing', postCheckRun: false, preflightImpl: async () => { called = true; throw new Error('no network in tests'); }, log: () => {},
  });
  return { res, called };
}

describe('P66 · only a v4 receipt bound to its envelope passes the gate', () => {
  for (const v of [1, 2, 3]) {
    it(`⚠⚠ a signed v${v} token + a hand-written sidecar envelope → failure receipt_version_unsupported (was exit 0)`, async () => {
      const { res, called } = await gateWithSidecar((s) => mintLegacy(s, v));
      assert.notEqual(res.exitCode, 0);
      assert.equal(res.gate.reason, 'receipt_version_unsupported');
      assert.equal(called, false, 'no preflight was asked to rescue it');
    });
  }

  it('a v4 receipt whose expires_at is not a string → not verified (no silent "never expires")', async () => {
    const { res } = await gateWithSidecar((s, env) => {
      // the array form the audit used (audit-2 F6); the signed bytes carry its string form
      const p = { v: 4, kid: s.kid, fp: 'sha256:' + 'a'.repeat(64), prev: 'null', caller: 'api', ts: '2026-10-01T00:00:00.000Z', reg: '', ir: '', expires_at: ['2020-01-01T00:00:00Z'], bh: bodyHash(env) };
      const input = `crchain.v1|${p.kid}|${p.fp}|${p.prev}|${p.caller}|${p.ts}|${p.reg}|${p.ir}|${p.expires_at}|${p.bh}`;
      return `${b64(JSON.stringify(p))}.${b64(crypto.sign(null, Buffer.from(input, 'utf8'), s.privateKey))}`;
    });
    assert.notEqual(res.exitCode, 0);
  });

  it('control: a v4 receipt bound to the same envelope still passes', async () => {
    const { res } = await gateWithSidecar((s, env) => mintV4(s, env, '2099-01-01T00:00:00.000Z'));
    assert.equal(res.exitCode, 0, JSON.stringify(res.gate));
  });

  it('v4BoundFault names the version; the vendored general verifier is unchanged (evidence chains keep older links)', () => {
    const { v4BoundFault } = require('../src/receipt-version');
    const s = signer();
    const keyring = new Map([[s.kid, { kid: s.kid, status: 'active', publicKey: crypto.createPublicKey(s.pem) }]]);
    const tok = mintLegacy(s, 2);
    const general = verifyReceipt(tok, { ctx: { keyring, expectedKid: null } });
    assert.equal(general.valid, true);
    assert.deepEqual(v4BoundFault(general, {}), { status: 'UNSUPPORTED_VERSION', reason: 'receipt_version_unsupported', version: 2 });
  });
});
