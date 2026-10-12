'use strict';

/*
 * v0.11.9 — the authorize request carries control_plane artifacts.
 * On dd9d287 the same cases fail: the body has no control_plane artifact,
 * a key path is not sent as empty text, a rename keeps one name, and a
 * request with a missing slot is still sent.
 * v1–v3 stays receipt_version_unsupported (src/receipt-version.js, p66).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runGate } = require('../src/index');
const { deriveArtifactsFromDiff, defaultGit } = require('../src/artifacts');
const { deriveControlPlaneArtifacts } = require('../src/control-plane');
const { missingAuthorizeSlot, buildPreflightRequest } = require('../src/preflight');
const { artifactDigestOf } = require('../src/receipt-trailer');
const { newSigner, mintV4, writeKeyringFile, envelope } = require('./mint');

const SPEC_USERS = 'openapi: 3.0.0\ninfo: { title: t, version: "1" }\npaths:\n  /users:\n    get: { responses: { "200": { description: ok } } }\n';
const SPEC_USERS_HEALTH = SPEC_USERS + '  /health:\n    get: { responses: { "200": { description: ok } } }\n';
const WF = '.github/workflows/contract-gate.yml';
const RENAMED = '.github/workflows/renamed.yml';
const KEY = '.coderifts/keys/a.pem';
const KEY_TEXT = 'PATH-ONLY-SECRET-MARKER do not send this text\n';

const signer = newSigner('test-k1');
const keyringPath = writeKeyringFile(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-v0119-')), signer);

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-v0119-git-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t.t']);
  git(dir, ['config', 'user.name', 't']);
  return dir;
}

function writeRel(dir, rel, body) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function makeRepo(baseFiles, headFiles) {
  const dir = initRepo();
  for (const [rel, body] of Object.entries(baseFiles)) writeRel(dir, rel, body);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  const baseSha = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['checkout', '-q', '-b', 'feature']);
  for (const [rel, body] of Object.entries(headFiles)) writeRel(dir, rel, body);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'head']);
  const headSha = git(dir, ['rev-parse', 'HEAD']).trim();
  return { dir, baseSha, headSha };
}

function receiptFor(repo, arts, { execution_action, decision, receipt_id }) {
  const d = artifactDigestOf(arts);
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
  return { chain_receipt: mintV4(signer, env), decision_result: env };
}

async function run(repo, { apiKey = 'k', owner = 'alpha', repoName = 'one', preflightImpl, headSha } = {}) {
  const calls = [];
  const res = await runGate({
    apiKey,
    apiUrl: 'https://x',
    githubToken: 't',
    owner,
    repo: repoName,
    baseSha: repo.baseSha,
    headSha: headSha || repo.headSha,
    cwd: repo.dir,
    keyringPath,
    profile: 'enforcing',
    postCheckRun: false,
    preflightImpl: async (req) => {
      calls.push(req);
      if (!preflightImpl) throw new Error('preflight is forbidden in this test');
      return preflightImpl(req);
    },
    postCheckRunImpl: async () => { throw new Error('check-run post is forbidden in this test'); },
    log: () => {},
  });
  return { res, calls };
}

test('v0.11.9 sends control_plane artifacts', async (t) => {
  await t.test('workflow-only: one control_plane artifact, four slots, REQUIRE_APPROVAL is receipt_not_allow', async () => {
    const repo = makeRepo(
      { [WF]: 'name: contract-gate\n' },
      { [WF]: 'name: contract-gate\n# control-plane probe 2026-10-12\n' },
    );
    const cp = deriveControlPlaneArtifacts({
      baseRef: repo.baseSha, headRef: repo.headSha, cwd: repo.dir, gitImpl: defaultGit,
    });
    const body = receiptFor(repo, cp.artifacts, {
      execution_action: 'REQUEST_APPROVAL',
      decision: 'REQUIRE_APPROVAL',
      receipt_id: 'rcpt_v0119',
    });
    const { res, calls } = await run(repo, {
      preflightImpl: async () => body,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].artifacts.length, 1);
    assert.equal(calls[0].artifacts[0].type, 'control_plane');
    assert.equal(calls[0].artifacts[0].id, WF);
    assert.match(calls[0].artifacts[0].before, /name: contract-gate/);
    assert.match(calls[0].artifacts[0].after, /2026-10-12/);
    assert.equal(calls[0].preflight_mode, 'authorize');
    assert.equal(calls[0].context.operation, 'merge');
    assert.equal(calls[0].context.repository, 'alpha/one');
    assert.equal(calls[0].context.base, repo.baseSha);
    assert.equal(calls[0].context.head, repo.headSha);
    assert.equal(res.exitCode, 1);
    assert.equal(res.gate.reason, 'receipt_not_allow');
  });

  await t.test('mixed diff: contract and control_plane in one body', async () => {
    const repo = makeRepo(
      { 'api/openapi.yaml': SPEC_USERS, [WF]: 'name: contract-gate\n' },
      { 'api/openapi.yaml': SPEC_USERS_HEALTH, [WF]: 'name: contract-gate\n# probe\n' },
    );
    const derived = deriveArtifactsFromDiff({ baseRef: repo.baseSha, headRef: repo.headSha, cwd: repo.dir });
    const cp = deriveControlPlaneArtifacts({
      baseRef: repo.baseSha, headRef: repo.headSha, cwd: repo.dir, gitImpl: defaultGit,
    });
    const arts = derived.artifacts.concat(cp.artifacts);
    const body = receiptFor(repo, arts, {
      execution_action: 'CONTINUE',
      decision: 'ALLOW',
      receipt_id: 'rcpt_mix',
    });
    const { res, calls } = await run(repo, { preflightImpl: async () => body });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].artifacts.map((a) => a.type).sort(), ['control_plane', 'openapi']);
    assert.equal(res.exitCode, 0);
    assert.equal(res.gate.reason, 'signed_allow_for_diff');
  });

  await t.test('a receipt bound only to the contract artifact is not an allow when the workflow also changed', async () => {
    const repo = makeRepo(
      { 'api/openapi.yaml': SPEC_USERS, [WF]: 'name: contract-gate\n' },
      { 'api/openapi.yaml': SPEC_USERS_HEALTH, [WF]: 'name: contract-gate\n# probe\n' },
    );
    const derived = deriveArtifactsFromDiff({ baseRef: repo.baseSha, headRef: repo.headSha, cwd: repo.dir });
    const body = receiptFor(repo, derived.artifacts, {
      execution_action: 'CONTINUE',
      decision: 'ALLOW',
      receipt_id: 'rcpt_contract_only',
    });
    const { res, calls } = await run(repo, { preflightImpl: async () => body });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].artifacts.length, 2);
    assert.equal(res.exitCode, 1);
    assert.equal(res.gate.reason, 'target_mismatch');
  });

  await t.test('a key file path is sent with empty before and after, and the file text is absent', async () => {
    const repo = makeRepo(
      { [KEY]: KEY_TEXT },
      { [KEY]: `${KEY_TEXT}rotated\n` },
    );
    const { calls } = await run(repo, {
      preflightImpl: async () => {
        throw new Error('stop after capture');
      },
    });
    assert.equal(calls.length, 1);
    const art = calls[0].artifacts.find((a) => a.id === KEY);
    assert.ok(art);
    assert.equal(art.type, 'control_plane');
    assert.equal(art.before, '');
    assert.equal(art.after, '');
    const serialized = JSON.stringify(buildPreflightRequest({
      artifacts: calls[0].artifacts,
      context: calls[0].context,
      preflight_mode: calls[0].preflight_mode,
    }));
    assert.equal(serialized.includes('PATH-ONLY-SECRET-MARKER'), false);
    assert.equal(serialized.includes('rotated'), false);
  });

  await t.test('git mv of a workflow sends the old path with after empty and the new path', async () => {
    const dir = initRepo();
    writeRel(dir, WF, 'name: contract-gate\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'base']);
    const baseSha = git(dir, ['rev-parse', 'HEAD']).trim();
    git(dir, ['checkout', '-q', '-b', 'feature']);
    git(dir, ['mv', WF, RENAMED]);
    git(dir, ['commit', '-q', '-m', 'rename']);
    const headSha = git(dir, ['rev-parse', 'HEAD']).trim();
    const repo = { dir, baseSha, headSha };
    const { calls } = await run(repo, {
      preflightImpl: async () => { throw new Error('stop after capture'); },
    });
    assert.equal(calls.length, 1);
    const byId = Object.fromEntries(calls[0].artifacts.map((a) => [a.id, a]));
    assert.equal(byId[WF].type, 'control_plane');
    assert.equal(byId[WF].before, 'name: contract-gate\n');
    assert.equal(byId[WF].after, '');
    assert.equal(byId[RENAMED].type, 'control_plane');
    assert.equal(byId[RENAMED].before, '');
    assert.equal(byId[RENAMED].after, 'name: contract-gate\n');
  });

  await t.test('a missing repository slot is not sent', async () => {
    const repo = makeRepo(
      { [WF]: 'name: contract-gate\n' },
      { [WF]: 'name: contract-gate\n# slot\n' },
    );
    const { res, calls } = await run(repo, { owner: '', repoName: '' });
    assert.equal(calls.length, 0);
    assert.equal(res.exitCode, 1);
    assert.equal(res.gate.reason, 'invalid_context');
    assert.equal(res.gate.slot, 'repository');
  });
});

test('missingAuthorizeSlot names the slot', () => {
  const full = {
    preflight_mode: 'authorize',
    context: { repository: 'alpha/one', base: 'a', head: 'b', operation: 'merge' },
  };
  assert.equal(missingAuthorizeSlot(full), null);
  assert.equal(missingAuthorizeSlot({ ...full, preflight_mode: 'analyze' }), 'preflight_mode');
  assert.equal(missingAuthorizeSlot({ ...full, context: { ...full.context, repository: '/' } }), 'repository');
  assert.equal(missingAuthorizeSlot({ ...full, context: { ...full.context, base: '  ' } }), 'base');
  assert.equal(missingAuthorizeSlot({ ...full, context: { ...full.context, head: '' } }), 'head');
  assert.equal(missingAuthorizeSlot({ ...full, context: { ...full.context, operation: 'deploy' } }), 'operation');
});
