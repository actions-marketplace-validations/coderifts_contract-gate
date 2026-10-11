'use strict';

/*
 * v0.11.8 — a control-plane path is not no_contract_changes.
 * Real git, real vendored verify. Only the issuer response is stubbed.
 * On d3a91d1 (0.11.7) the control-plane cases fail: the action returns success
 * no_contract_changes and does not read the receipt.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runGate } = require('../src/index');
const { deriveArtifactsFromDiff } = require('../src/artifacts');
const { artifactDigestOf } = require('../src/receipt-trailer');
const { newSigner, mintV4, writeKeyringFile, envelope } = require('./mint');

const SPEC_USERS = 'openapi: 3.0.0\ninfo: { title: t, version: "1" }\npaths:\n  /users:\n    get: { responses: { "200": { description: ok } } }\n';
const SPEC_USERS_HEALTH = SPEC_USERS + '  /health:\n    get: { responses: { "200": { description: ok } } }\n';
const WF = '.github/workflows/contract-gate.yml';

const signer = newSigner('test-k1');
const keyringPath = writeKeyringFile(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-v0118-')), signer);

function makeRepo(baseFiles, headFiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-v0118-git-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 't');
  for (const [rel, body] of Object.entries(baseFiles)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const baseSha = g('rev-parse', 'HEAD').trim();
  g('checkout', '-q', '-b', 'feature');
  for (const [rel, body] of Object.entries(headFiles)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  g('add', '-A');
  g('commit', '-q', '-m', 'head');
  const headSha = g('rev-parse', 'HEAD').trim();
  return { dir, baseSha, headSha };
}

function workflowOnly() {
  return makeRepo(
    { [WF]: 'name: contract-gate\n' },
    { [WF]: 'name: contract-gate\n# control-plane probe 2026-10-11\n' },
  );
}

function issued(repo, { execution_action, decision, receipt_id }) {
  const derived = deriveArtifactsFromDiff({ baseRef: repo.baseSha, headRef: repo.headSha, cwd: repo.dir });
  const d = artifactDigestOf(derived.artifacts);
  const env = envelope({
    execution_action,
    decision,
    extra: {
      artifact_digest: d,
      target_id: d,
      operation: 'merge',
      preflight_mode: 'authorize',
      repository: 'alpha/one',
      base: repo.baseSha,
      head: repo.headSha,
      receipt_id,
    },
  });
  return { chain_receipt: mintV4(signer, env), decision_result: env, artifacts: derived.artifacts };
}

async function run(repo, { apiKey = 'k', on = false, profile = 'enforcing', preflightImpl, postCheckRun = false, logs = null } = {}) {
  const calls = [];
  const res = await runGate({
    apiKey,
    apiUrl: 'https://x',
    githubToken: 't',
    owner: 'alpha',
    repo: 'one',
    baseSha: repo.baseSha,
    headSha: repo.headSha,
    cwd: repo.dir,
    keyringPath,
    preflightImpl: async (req) => {
      calls.push(req);
      if (!preflightImpl) throw new Error('preflight is forbidden in this test');
      return preflightImpl(req);
    },
    postCheckRunImpl: async () => { throw new Error('check-run post is forbidden in this test'); },
    log: (line) => { if (logs) logs.push(line); },
    requireReceiptTrailer: on,
    profile,
    postCheckRun,
  });
  return { res, calls };
}

function withSurface(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-v0118-surface-'));
  const summaryPath = path.join(dir, 'summary.md');
  const outputPath = path.join(dir, 'output.txt');
  fs.writeFileSync(summaryPath, '');
  fs.writeFileSync(outputPath, '');
  const prevS = process.env.GITHUB_STEP_SUMMARY;
  const prevO = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_STEP_SUMMARY = summaryPath;
  process.env.GITHUB_OUTPUT = outputPath;
  return Promise.resolve()
    .then(fn)
    .then((value) => ({
      value,
      summary: fs.readFileSync(summaryPath, 'utf8'),
      output: fs.readFileSync(outputPath, 'utf8'),
    }))
    .finally(() => {
      if (prevS == null) delete process.env.GITHUB_STEP_SUMMARY;
      else process.env.GITHUB_STEP_SUMMARY = prevS;
      if (prevO == null) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = prevO;
    });
}

test('v0.11.8 control-plane receipt path', async (t) => {
  await t.test('workflow-only with a key: issuer REQUIRE_APPROVAL is receipt_not_allow', async () => {
    const repo = workflowOnly();
    const body = issued(repo, {
      execution_action: 'REQUEST_APPROVAL',
      decision: 'REQUIRE_APPROVAL',
      receipt_id: 'rcpt_cp',
    });
    const logs = [];
    const { value, summary, output } = await withSurface(() => run(repo, {
      preflightImpl: async () => ({ chain_receipt: body.chain_receipt, decision_result: body.decision_result }),
      logs,
    }));
    const { res, calls } = value;
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].artifacts, []);
    assert.equal(res.exitCode, 1);
    assert.equal(res.gate.reason, 'receipt_not_allow');
    assert.match(summary, /receipt_not_allow/);
    assert.match(summary, /\.github\/workflows\/contract-gate\.yml/);
    assert.match(summary, /CONTROL_PLANE_CHANGE|ci_workflow/);
    assert.match(output, /^reason=receipt_not_allow$/m);
    assert.match(output, /CONTROL_PLANE_CHANGE/);
    assert.match(output, /\.github\/workflows\/contract-gate\.yml/);
    const posted = logs.filter((l) => l.startsWith('[check not posted — post-check-run:false]'));
    assert.equal(posted.length, 1);
    assert.match(posted[0], /reason=receipt_not_allow/);
    assert.match(posted[0], /receipt-id=rcpt_cp/);
    assert.match(posted[0], /CONTROL_PLANE_CHANGE/);
    assert.match(posted[0], /control-plane=\.github\/workflows\/contract-gate\.yml/);
  });

  await t.test('workflow-only with no key is receipt_trailer_missing and does not call', async () => {
    const logs = [];
    const { value, summary, output } = await withSurface(() => run(workflowOnly(), { apiKey: '', logs }));
    const { res, calls } = value;
    assert.equal(calls.length, 0);
    assert.equal(res.exitCode, 1);
    assert.equal(res.gate.reason, 'receipt_trailer_missing');
    assert.match(summary, /receipt_trailer_missing/);
    assert.match(summary, /\.github\/workflows\/contract-gate\.yml/);
    assert.match(output, /^reason=receipt_trailer_missing$/m);
    assert.match(output, /\.github\/workflows\/contract-gate\.yml/);
    const posted = logs.filter((l) => l.startsWith('[check not posted — post-check-run:false]'));
    assert.match(posted[0], /reason=receipt_trailer_missing/);
    assert.match(posted[0], /control-plane=\.github\/workflows\/contract-gate\.yml/);
  });

  await t.test('workflow-only with require-receipt-trailer true is receipt_trailer_required before any call', async () => {
    const { value } = await withSurface(() => run(workflowOnly(), { on: true, apiKey: 'k' }));
    const { res, calls } = value;
    assert.equal(calls.length, 0);
    assert.equal(res.exitCode, 1);
    assert.equal(res.gate.reason, 'receipt_trailer_required');
  });

  await t.test('README-only stays neutral', async () => {
    const repo = makeRepo({ 'README.md': 'a\n' }, { 'README.md': 'b\n' });
    const { res, calls } = await run(repo, { apiKey: 'k' });
    assert.equal(calls.length, 0);
    assert.equal(res.exitCode, 0);
    assert.equal(res.gate.reason, 'no_contract_changes');
  });

  await t.test('contract plus workflow keeps the contract path and names the workflow in the summary', async () => {
    const repo = makeRepo(
      { 'api/openapi.yaml': SPEC_USERS, [WF]: 'name: contract-gate\n' },
      { 'api/openapi.yaml': SPEC_USERS_HEALTH, [WF]: 'name: contract-gate\n# probe\n' },
    );
    const body = issued(repo, {
      execution_action: 'CONTINUE',
      decision: 'ALLOW',
      receipt_id: 'rcpt_mix',
    });
    assert.equal(body.artifacts.length, 1);
    assert.equal(body.artifacts[0].id, 'api/openapi.yaml');
    const logs = [];
    const { value, summary, output } = await withSurface(() => run(repo, {
      preflightImpl: async () => ({ chain_receipt: body.chain_receipt, decision_result: body.decision_result }),
      logs,
    }));
    const { res, calls } = value;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].artifacts.length, 1);
    assert.equal(calls[0].artifacts[0].id, 'api/openapi.yaml');
    assert.equal(res.exitCode, 0);
    assert.equal(res.gate.reason, 'signed_allow_for_diff');
    assert.equal(res.gate.preflight, true);
    assert.match(summary, /signed_allow_for_diff/);
    assert.match(summary, /\.github\/workflows\/contract-gate\.yml/);
    assert.match(output, /^reason=signed_allow_for_diff$/m);
    assert.match(output, /\.github\/workflows\/contract-gate\.yml/);
    const posted = logs.filter((l) => l.startsWith('[check not posted — post-check-run:false]'));
    assert.match(posted[0], /reason=signed_allow_for_diff/);
    assert.match(posted[0], /receipt-id=rcpt_mix/);
    assert.match(posted[0], /control-plane=\.github\/workflows\/contract-gate\.yml/);
  });
});

test('control-plane list matches coderifts-app src/mergegate/control-plane.js', () => {
  const { classifyControlPlanePath } = require('../src/control-plane');
  const yes = (p, cls) => {
    const c = classifyControlPlanePath(p);
    assert.equal(c.control_plane, true, p);
    assert.equal(c.class, cls, p);
  };
  const no = (p) => assert.equal(classifyControlPlanePath(p).control_plane, false, p);
  yes('.github/workflows/contract-gate.yml', 'ci_workflow');
  yes('.github/workflows/a.yaml', 'ci_workflow');
  yes('./.github/workflows/a.yml', 'ci_workflow');
  no('.github/workflows/nested/a.yml');
  no('.github/ISSUE_TEMPLATE/bug.yml');
  yes('.coderifts.yml', 'approver_config');
  yes('.coderifts.yaml', 'approver_config');
  yes('.coderifts/keys/a.pem', 'trust_anchor');
  yes('.coderifts/trust/k', 'trust_anchor');
  yes('.coderifts/signing/k', 'trust_anchor');
  yes('.coderifts/extra.pem', 'trust_anchor');
  yes('.coderifts/extra.PUB', 'trust_anchor');
  no('src/key.pem');
  yes('.coderifts/audit.yml', 'audit_config');
  yes('.coderifts/audit.yaml', 'audit_config');
  yes('coderifts-audit.yml', 'audit_config');
  no('README.md');
  no('api/openapi.yaml');
});
