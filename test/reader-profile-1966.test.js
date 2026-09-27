'use strict';

/*
 * 1966 — the reader profile. A valid trailer does not wait for a preflight response.
 * A missing trailer is issued, then verified offline the same way, and is not written
 * back onto the commit. The spec bytes are the demo repository's OpenAPI document
 * with the User.phone property removed (the PR #4 shape: a field deletion).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runGate } = require('../src/index');
const { artifactDigestOf } = require('../src/receipt-trailer');
const { newSigner, mintV4, tamperSignature, writeKeyringFile, envelope } = require('./mint');

const DEMO_SPEC = path.join(__dirname, '..', '..', 'coderifts-demo', 'api', 'openapi.yaml');
const PHONE = [
  '        phone:',
  '          type: string',
  '          nullable: true',
  '          description: "User\'s phone number in E.164 format."',
  '',
].join('\n');

const signer = newSigner('test-k1');
const keyringPath = writeKeyringFile(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1966-')), signer);

function specs() {
  const base = fs.readFileSync(DEMO_SPEC, 'utf8');
  assert.ok(base.includes(PHONE), 'demo openapi no longer contains the User.phone block this test deletes');
  return { base, head: base.replace(PHONE, '') };
}

function makeRepo({ trailer = null, sidecar = null, spec = specs() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1966-git-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'api/openapi.yaml'), spec.base);
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const baseSha = g('rev-parse', 'HEAD').trim();
  g('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'api/openapi.yaml'), spec.head);
  g('add', '-A');
  g('commit', '-q', '-m', trailer ? `head\n\nCodeRifts-Receipt: ${trailer}` : 'head');
  const headSha = g('rev-parse', 'HEAD').trim();
  if (sidecar) {
    fs.mkdirSync(path.join(dir, '.coderifts', 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.coderifts', 'receipts', `${headSha}.json`), JSON.stringify(sidecar));
  }
  return { dir, baseSha, headSha, spec };
}

function digestOf(spec) {
  return artifactDigestOf([{ id: 'api/openapi.yaml', type: 'openapi', before: spec.base, after: spec.head }]);
}

function allowEnv(digest, over = {}) {
  return envelope({
    execution_action: 'CONTINUE',
    decision: 'ALLOW',
    extra: { artifact_digest: digest, target_id: digest, operation: 'merge', preflight_mode: 'authorize', ...over },
  });
}

function attach(spec, env, { token = mintV4(signer, env), bad = false } = {}) {
  const repo = makeRepo({
    spec,
    trailer: token,
    sidecar: { receipt: token, envelope: env },
  });
  return { repo, token, env };
}

async function run(repo, { apiKey = 'k', preflightImpl } = {}) {
  const calls = { n: 0 };
  const check = {};
  const network = preflightImpl || (async () => { throw new Error('network is forbidden in this test'); });
  const wrapped = async (req) => {
    calls.n += 1;
    return network(req);
  };
  const res = await runGate({
    apiKey, apiUrl: 'https://x', githubToken: 't', owner: 'o', repo: 'r',
    baseSha: repo.baseSha, headSha: repo.headSha, cwd: repo.dir, keyringPath,
    preflightImpl: wrapped,
    postCheckRunImpl: async ({ conclusion, summary }) => {
      check.conclusion = conclusion;
      check.summary = summary;
      return { ok: true, status: 201 };
    },
    log: () => {},
    profile: 'enforcing',
  });
  return { res, check, calls };
}

const spec = specs();
const digest = digestOf(spec);

test('no receipt and no key → failure, and preflight is not called', async () => {
  const { res, check, calls } = await run(makeRepo({ spec }), { apiKey: '' });
  assert.equal(res.exitCode, 1);
  assert.equal(res.gate.reason, 'receipt_trailer_missing');
  assert.equal(check.conclusion, 'failure');
  assert.equal(calls.n, 0);
});

test('another PR receipt → target_mismatch', async () => {
  const env = allowEnv('sha256:' + '0'.repeat(64));
  const { repo } = attach(spec, env);
  const { res, check, calls } = await run(repo);
  assert.equal(res.exitCode, 1);
  assert.equal(res.gate.reason, 'target_mismatch');
  assert.equal(check.conclusion, 'failure');
  assert.equal(calls.n, 0);
});

test('expired receipt → failure', async () => {
  const env = allowEnv(digest);
  const token = mintV4(signer, env, { expires_at: '2020-01-01T00:00:00.000Z' });
  const { repo } = attach(spec, env, { token });
  const { res, check, calls } = await run(repo);
  assert.equal(res.exitCode, 1);
  assert.equal(res.gate.reason, 'VERIFIED_EXPIRED');
  assert.equal(check.conclusion, 'failure');
  assert.equal(calls.n, 0);
});

test('a deploy receipt on a merge → operation_mismatch', async () => {
  const env = allowEnv(digest, { operation: 'deploy' });
  const { repo } = attach(spec, env);
  const { res, calls } = await run(repo);
  assert.equal(res.exitCode, 1);
  assert.equal(res.gate.reason, 'operation_mismatch');
  assert.equal(calls.n, 0);
});

test('a modified signature → INVALID_SIGNATURE', async () => {
  const env = allowEnv(digest);
  const token = tamperSignature(mintV4(signer, env));
  const { repo } = attach(spec, env, { token });
  const { res, calls } = await run(repo);
  assert.equal(res.exitCode, 1);
  assert.equal(res.gate.reason, 'INVALID_SIGNATURE');
  assert.equal(calls.n, 0);
});

test('trailered ALLOW → success, and the network is not called', async () => {
  const env = allowEnv(digest);
  const { repo, token } = attach(spec, env);
  const { res, check, calls } = await run(repo);
  assert.equal(res.exitCode, 0);
  assert.equal(res.gate.preflight, false);
  assert.equal(check.conclusion, 'success');
  assert.equal(calls.n, 0);
  assert.match(check.summary, /VERIFIED_CURRENT · currently_authorized: true/);
  assert.match(check.summary, new RegExp(`npx @coderifts/receipt-verifier --from-commit ${repo.headSha}`));
  assert.match(check.summary, /trailer\/sidecar/);
  assert.ok(!check.summary.includes(token) || check.summary.includes('--from-commit'));
});

test('no trailer → fallback issuance, local verify, summary carries the receipt, commit untouched', async () => {
  const env = allowEnv(digest);
  const token = mintV4(signer, env);
  const repo = makeRepo({ spec });
  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.dir, encoding: 'utf8' }).trim();
  const { res, check, calls } = await run(repo, {
    preflightImpl: async () => ({ chain_receipt: token, decision_result: env }),
  });
  assert.equal(calls.n, 1);
  assert.equal(res.exitCode, 0);
  assert.equal(res.gate.preflight, true);
  assert.equal(check.conclusion, 'success');
  assert.match(check.summary, /issued in this run — not in the commit/);
  assert.ok(check.summary.includes(token));
  const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.dir, encoding: 'utf8' }).trim();
  assert.equal(headAfter, headBefore);
  assert.equal(fs.existsSync(path.join(repo.dir, '.coderifts', 'receipts', `${repo.headSha}.json`)), false);
});
