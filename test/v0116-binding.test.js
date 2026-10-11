'use strict';

/*
 * v0.11.6 — the enforcing reader binds a receipt to this run, require-receipt-trailer
 * fails closed, and the action job writes the receipt to the step summary and outputs.
 * Real git, real vendored verify. Only preflight is stubbed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runGate } = require('../src/index');
const { judgeReceipt, artifactDigestOf } = require('../src/receipt-trailer');
const { loadKeyring } = require('../src/verify');
const { newSigner, mintV4, tamperSignature, writeKeyringFile, envelope } = require('./mint');

const SPEC_USERS = 'openapi: 3.0.0\ninfo: { title: t, version: "1" }\npaths:\n  /users:\n    get: { responses: { "200": { description: ok } } }\n';
const SPEC_USERS_HEALTH = SPEC_USERS + '  /health:\n    get: { responses: { "200": { description: ok } } }\n';

const signer = newSigner('test-k1');
const keyringPath = writeKeyringFile(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-v0116-')), signer);

function digest() {
  return artifactDigestOf([{ id: 'api/openapi.yaml', type: 'openapi', before: SPEC_USERS, after: SPEC_USERS_HEALTH }]);
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-v0116-git-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'api/openapi.yaml'), SPEC_USERS);
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const baseSha = g('rev-parse', 'HEAD').trim();
  g('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'api/openapi.yaml'), SPEC_USERS_HEALTH);
  g('add', '-A');
  g('commit', '-q', '-m', 'head');
  const headSha = g('rev-parse', 'HEAD').trim();
  return { dir, baseSha, headSha };
}

function queueHead(repo) {
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'queue'], { cwd: repo.dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.dir, encoding: 'utf8' }).trim();
}

function writeSidecar(repo, sha, token, env) {
  const dir = path.join(repo.dir, '.coderifts', 'receipts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sha}.json`), JSON.stringify({ receipt: token, envelope: env }));
}

function bound(repo, over = {}) {
  const d = digest();
  return envelope({
    execution_action: 'CONTINUE',
    decision: 'ALLOW',
    extra: {
      artifact_digest: d,
      target_id: d,
      operation: 'merge',
      preflight_mode: 'authorize',
      repository: 'alpha/one',
      base: repo.baseSha,
      head: repo.headSha,
      receipt_id: 'rcpt_pref',
      ...over,
    },
  });
}

function attach(repo, env, sha = repo.headSha) {
  const token = mintV4(signer, env);
  writeSidecar(repo, sha, token, env);
  return token;
}

async function run(repo, {
  owner = 'alpha', repoName = 'one', baseSha, headSha, on = false, profile = 'enforcing',
  eventKind = null, preflightImpl, postCheckRun = true, apiKey = 'k', logs = null,
} = {}) {
  const calls = { n: 0 };
  const posted = { n: 0 };
  const network = preflightImpl || (async () => { throw new Error('preflight is forbidden in this test'); });
  const res = await runGate({
    apiKey, apiUrl: 'https://x', githubToken: 't',
    owner, repo: repoName,
    baseSha: baseSha || repo.baseSha,
    headSha: headSha || repo.headSha,
    cwd: repo.dir,
    keyringPath,
    preflightImpl: async () => { calls.n += 1; return network(); },
    postCheckRunImpl: async () => { posted.n += 1; return { ok: true, status: 201 }; },
    log: (line) => { if (logs) logs.push(line); },
    requireReceiptTrailer: on,
    profile,
    eventKind,
    postCheckRun,
  });
  return { res, calls, posted };
}

function issuedFor(headSha, baseSha) {
  const d = digest();
  const env = envelope({
    execution_action: 'CONTINUE',
    decision: 'ALLOW',
    extra: {
      artifact_digest: d,
      target_id: d,
      operation: 'merge',
      preflight_mode: 'authorize',
      repository: 'alpha/one',
      base: baseSha,
      head: headSha,
      receipt_id: 'rcpt_issued',
    },
  });
  return { chain_receipt: mintV4(signer, env), decision_result: env };
}

test('v0.11.6 receipt binding, trailer flag, and run surface', async (t) => {
  await t.test('the same receipt verifies on repo A / head H1', async () => {
    const repo = makeRepo();
    const env = bound(repo);
    attach(repo, env);
    const { res, calls } = await run(repo);
    assert.equal(res.exitCode, 0);
    assert.equal(res.gate.reason, 'signed_allow_for_diff');
    assert.equal(res.gate.preflight, false);
    assert.equal(calls.n, 0);
  });

  await t.test('the same receipt on repo B is repo_mismatch and does not issue', async () => {
    const repo = makeRepo();
    const env = bound(repo);
    attach(repo, env);
    const { res, calls } = await run(repo, { owner: 'beta', repoName: 'two' });
    assert.equal(res.exitCode, 1);
    assert.equal(res.gate.reason, 'repo_mismatch');
    assert.equal(calls.n, 0);
  });

  await t.test('the same receipt on head H2 with the same bytes is head_mismatch', async () => {
    const repo = makeRepo();
    const env = bound(repo);
    const token = mintV4(signer, env);
    const h2 = queueHead(repo);
    writeSidecar(repo, h2, token, env);
    const { res, calls } = await run(repo, { headSha: h2 });
    assert.equal(res.exitCode, 1);
    assert.equal(res.gate.reason, 'head_mismatch');
    assert.equal(calls.n, 0);
  });

  await t.test('the same receipt on another base, same artifact bytes, is base_mismatch', async () => {
    const repo = makeRepo();
    const env = bound(repo);
    const token = mintV4(signer, env);
    const artifacts = [{ id: 'api/openapi.yaml', type: 'openapi', before: SPEC_USERS, after: SPEC_USERS_HEALTH }];
    assert.equal(artifactDigestOf(artifacts), digest());
    const keyring = await loadKeyring(keyringPath);
    const same = judgeReceipt({
      token, envelope: env, carrier: 'sidecar', keyring, artifacts, profile: 'enforcing',
      repository: 'alpha/one', base: repo.baseSha, head: repo.headSha,
    });
    assert.equal(same.ok, true);
    const other = judgeReceipt({
      token, envelope: env, carrier: 'sidecar', keyring, artifacts, profile: 'enforcing',
      repository: 'alpha/one', base: 'b'.repeat(40), head: repo.headSha,
    });
    assert.equal(other.ok, false);
    assert.equal(other.reason, 'base_mismatch');
    attach(repo, env);
    const viaRun = await run(repo, { owner: 'alpha', repoName: 'one' });
    assert.equal(viaRun.res.exitCode, 0);
    const mismatchedBase = bound(repo, { base: 'b'.repeat(40) });
    const repo2 = makeRepo();
    attach(repo2, mismatchedBase);
    const { res, calls } = await run(repo2);
    assert.equal(res.gate.reason, 'base_mismatch');
    assert.equal(calls.n, 0);
  });

  await t.test('preflight_mode analyze is mode_mismatch', async () => {
    const repo = makeRepo();
    attach(repo, bound(repo, { preflight_mode: 'analyze' }));
    const { res, calls } = await run(repo);
    assert.equal(res.exitCode, 1);
    assert.equal(res.gate.reason, 'mode_mismatch');
    assert.equal(calls.n, 0);
  });

  await t.test('a carried receipt that omits the four slots still verifies', async () => {
    const repo = makeRepo();
    const d = digest();
    const env = envelope({
      execution_action: 'CONTINUE',
      decision: 'ALLOW',
      extra: { artifact_digest: d, target_id: d, operation: 'merge' },
    });
    attach(repo, env);
    const { res, calls } = await run(repo);
    assert.equal(res.exitCode, 0);
    assert.equal(res.gate.preflight, false);
    assert.equal(calls.n, 0);
  });

  await t.test('an issued receipt that omits repository fails closed', async () => {
    const repo = makeRepo();
    const d = digest();
    const env = envelope({
      execution_action: 'CONTINUE',
      decision: 'ALLOW',
      extra: {
        artifact_digest: d, target_id: d, operation: 'merge', preflight_mode: 'authorize',
        base: repo.baseSha, head: repo.headSha,
      },
    });
    const { res, calls } = await run(repo, {
      preflightImpl: async () => ({ chain_receipt: mintV4(signer, env), decision_result: env }),
    });
    assert.equal(calls.n, 1);
    assert.equal(res.exitCode, 1);
    assert.equal(res.gate.reason, 'repo_mismatch');
  });

  await t.test('merge_group: a PR-head receipt falls through to issuance and is not a trailer success', async () => {
    const repo = makeRepo();
    const env = bound(repo);
    const token = mintV4(signer, env);
    const h2 = queueHead(repo);
    writeSidecar(repo, h2, token, env);
    const { res, calls } = await run(repo, {
      headSha: h2,
      eventKind: 'merge_group',
      preflightImpl: async () => issuedFor(h2, repo.baseSha),
    });
    assert.equal(calls.n, 1);
    assert.equal(res.exitCode, 0);
    assert.equal(res.gate.preflight, true);
    assert.equal(res.gate.reason, 'signed_allow_for_diff');
    assert.equal(res.receiptTrailer, undefined);
  });

  await t.test('merge_group with require-receipt-trailer stays a head_mismatch', async () => {
    const repo = makeRepo();
    const env = bound(repo);
    const token = mintV4(signer, env);
    const h2 = queueHead(repo);
    writeSidecar(repo, h2, token, env);
    const { res, calls } = await run(repo, { headSha: h2, eventKind: 'merge_group', on: true });
    assert.equal(res.exitCode, 1);
    assert.equal(res.gate.reason, 'head_mismatch');
    assert.equal(calls.n, 0);
  });

  await t.test('merge_group repo_mismatch does not fall through', async () => {
    const repo = makeRepo();
    attach(repo, bound(repo, { repository: 'beta/two' }));
    const { res, calls } = await run(repo, { eventKind: 'merge_group' });
    assert.equal(res.exitCode, 1);
    assert.equal(res.gate.reason, 'repo_mismatch');
    assert.equal(calls.n, 0);
  });

  await t.test('require-receipt-trailer true and no trailer is receipt_trailer_required before preflight', async () => {
    for (const profile of ['enforcing', 'off']) {
      const { res, calls } = await run(makeRepo(), { on: true, profile, apiKey: 'k' });
      assert.equal(calls.n, 0, profile);
      assert.equal(res.exitCode, 1, profile);
      assert.equal(res.gate.reason, 'receipt_trailer_required', profile);
    }
  });

  await t.test('require-receipt-trailer false still issues on the enforcing profile', async () => {
    const repo = makeRepo();
    const { res, calls } = await run(repo, {
      on: false,
      preflightImpl: async () => issuedFor(repo.headSha, repo.baseSha),
    });
    assert.equal(calls.n, 1);
    assert.equal(res.exitCode, 0);
    assert.equal(res.gate.preflight, true);
    assert.equal(res.gate.reason, 'signed_allow_for_diff');
  });

  await t.test('a bad signature fails before the binding reasons', async () => {
    const repo = makeRepo();
    const env = bound(repo, { repository: 'beta/two' });
    const token = tamperSignature(mintV4(signer, env));
    writeSidecar(repo, repo.headSha, token, env);
    const { res, calls } = await run(repo);
    assert.equal(res.gate.reason, 'INVALID_SIGNATURE');
    assert.equal(calls.n, 0);
  });

  await t.test('a different diff fails target_mismatch before the binding reasons', async () => {
    const repo = makeRepo();
    const d = 'sha256:' + '0'.repeat(64);
    const env = envelope({
      execution_action: 'CONTINUE',
      decision: 'ALLOW',
      extra: {
        artifact_digest: d, target_id: d, operation: 'merge', preflight_mode: 'authorize',
        repository: 'beta/two', base: repo.baseSha, head: repo.headSha,
      },
    });
    attach(repo, env);
    const { res, calls } = await run(repo);
    assert.equal(res.gate.reason, 'target_mismatch');
    assert.equal(calls.n, 0);
  });

  await t.test('step summary and outputs carry the five lines, the receipt id, and the reason', async () => {
    const repo = makeRepo();
    attach(repo, bound(repo));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-v0116-surface-'));
    const summaryPath = path.join(dir, 'summary.md');
    const outputPath = path.join(dir, 'output.txt');
    fs.writeFileSync(summaryPath, '');
    fs.writeFileSync(outputPath, '');
    const prevS = process.env.GITHUB_STEP_SUMMARY;
    const prevO = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    process.env.GITHUB_OUTPUT = outputPath;
    try {
      const { res, posted } = await run(repo, { postCheckRun: false });
      assert.equal(res.exitCode, 0);
      assert.equal(posted.n, 0);
      const summary = fs.readFileSync(summaryPath, 'utf8');
      assert.match(summary, /CONTINUE · merge ·/);
      assert.match(summary, /VERIFIED_CURRENT · currently_authorized: true/);
      assert.match(summary, /sidecar/);
      assert.match(summary, /npx @coderifts\/receipt-verifier --from-commit /);
      assert.match(summary, /the approver is not in the signature/);
      assert.match(summary, /conclusion: success/);
      assert.match(summary, /receipt-id: rcpt_pref/);
      assert.match(summary, /target_id: sha256:/);
      assert.match(summary, /expires_at: 2027-01-01T00:00:00\.000Z/);
      assert.match(summary, /reason: signed_allow_for_diff/);
      const output = fs.readFileSync(outputPath, 'utf8');
      assert.match(output, /^receipt-id=rcpt_pref$/m);
      assert.match(output, /^conclusion=success$/m);
      assert.match(output, /^reason=signed_allow_for_diff$/m);
      assert.match(output, /^title=Signed ALLOW verified for this diff$/m);
    } finally {
      if (prevS == null) delete process.env.GITHUB_STEP_SUMMARY;
      else process.env.GITHUB_STEP_SUMMARY = prevS;
      if (prevO == null) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = prevO;
    }
  });

  await t.test('the example aggregator prints the four outputs and the permissions are the minimum', () => {
    const ex = fs.readFileSync(path.join(__dirname, '..', 'examples', 'contract-gate.yml'), 'utf8');
    const live = ex.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#.*$/, '')).join('\n');
    const perm = live.slice(live.indexOf('permissions:'), live.indexOf('\njobs:'));
    assert.match(perm, /contents:\s*read/);
    assert.match(perm, /pull-requests:\s*read/);
    assert.ok(!/checks:\s*write/.test(perm), perm);
    assert.match(ex, /checks:\s*write/);
    assert.match(ex, /id:\s*gate/);
    assert.match(ex, /steps\.gate\.outputs\.receipt-id/);
    assert.match(ex, /steps\.gate\.outputs\.conclusion/);
    assert.match(ex, /steps\.gate\.outputs\.reason/);
    assert.match(ex, /steps\.gate\.outputs\.title/);
    assert.match(ex, /needs\.contract-gate-action\.outputs\.receipt-id/);
    assert.match(ex, /needs\.contract-gate-action\.outputs\.conclusion/);
    assert.match(ex, /needs\.contract-gate-action\.outputs\.reason/);
    assert.match(ex, /needs\.contract-gate-action\.outputs\.title/);
    assert.match(ex, /echo "receipt-id:/);
    assert.match(ex, /echo "conclusion:/);
    assert.match(ex, /echo "reason:/);
    assert.match(ex, /echo "title:/);
    assert.match(ex, /post-check-run:\s*'false'/);
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const fence = readme.slice(readme.indexOf('```yaml\n') + '```yaml\n'.length, readme.indexOf('\n```', readme.indexOf('```yaml\n')));
    assert.equal(fence + '\n', ex.endsWith('\n') ? ex : ex + '\n');
    const action = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
    const outs = action.slice(action.indexOf('\noutputs:\n'), action.indexOf('\nruns:\n'));
    for (const name of ['receipt-id', 'conclusion', 'reason', 'title']) {
      assert.match(outs, new RegExp(`\\n  ${name}:\\n`));
    }
    assert.ok(!/\n\s+value:/.test(outs), outs);
  });

  await t.test('post-check-run false log line carries reason and receipt-id', async () => {
    const title = 'Blocked — no verified receipt on the head commit';
    const notPosted = (lines) => lines.filter((l) => l.startsWith('[check not posted — post-check-run:false]'));

    const stopRepo = makeRepo();
    attach(stopRepo, bound(stopRepo, { execution_action: 'STOP', decision: 'BLOCK', receipt_id: 'rcpt_stop' }));
    const stopLogs = [];
    const stop = await run(stopRepo, { postCheckRun: false, logs: stopLogs });
    assert.equal(stop.res.exitCode, 1);
    assert.equal(stop.posted.n, 0);
    assert.equal(stop.res.gate.reason, 'receipt_not_allow');
    assert.deepEqual(notPosted(stopLogs), [
      `[check not posted — post-check-run:false] failure: ${title} reason=receipt_not_allow receipt-id=rcpt_stop`,
    ]);

    const misRepo = makeRepo();
    const misEnv = bound(misRepo, { receipt_id: 'rcpt_head' });
    const token = mintV4(signer, misEnv);
    const h2 = queueHead(misRepo);
    writeSidecar(misRepo, h2, token, misEnv);
    const misLogs = [];
    const mis = await run(misRepo, { headSha: h2, postCheckRun: false, logs: misLogs });
    assert.equal(mis.res.exitCode, 1);
    assert.equal(mis.posted.n, 0);
    assert.equal(mis.res.gate.reason, 'head_mismatch');
    assert.deepEqual(notPosted(misLogs), [
      `[check not posted — post-check-run:false] failure: ${title} reason=head_mismatch receipt-id=rcpt_head`,
    ]);

    const bareRepo = makeRepo();
    const bareLogs = [];
    const bare = await run(bareRepo, { postCheckRun: false, apiKey: '', logs: bareLogs });
    assert.equal(bare.res.exitCode, 1);
    assert.equal(bare.posted.n, 0);
    assert.equal(bare.res.gate.reason, 'receipt_trailer_missing');
    assert.deepEqual(notPosted(bareLogs), [
      `[check not posted — post-check-run:false] failure: ${title} reason=receipt_trailer_missing receipt-id=n/a`,
    ]);
  });
});
