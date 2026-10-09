'use strict';

/*
 * P65d (2026-10-09) — the Action: a changed plain mcp.json that is both an MCP client configuration and a
 * tool manifest ('mixed'), or that does not parse ('unparseable'), is not sent to preflight and does not
 * pass as "no contract change": runGate decides red (outcome MCP_JSON_HELD) with the package's sentence.
 * The vectors are coderifts-app's shared file (packages/contract-path/test/fixtures/mcp-json-vectors.json),
 * read where the mirror test reads the package; absent → skipped, named.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runGate } = require('../src/index');
const { deriveArtifactsFromDiff } = require('../src/artifacts');
const CP = require('../src/contract-path');

const VECTORS = path.join(process.env.HOME, 'coderifts-app', 'packages', 'contract-path', 'test', 'fixtures', 'mcp-json-vectors.json');
const shared = fs.existsSync(VECTORS) ? JSON.parse(fs.readFileSync(VECTORS, 'utf8')) : null;
const HELD = new Set(['mixed', 'unparseable']);

function repoWith(baseText, headText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p65d-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'mcp.json'), baseText);
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  const baseSha = g('rev-parse', 'HEAD').trim();
  g('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'mcp.json'), headText);
  g('add', '-A'); g('commit', '-q', '--allow-empty', '-m', 'head');
  return { dir, baseSha, headSha: g('rev-parse', 'HEAD').trim() };
}

test('the shared vectors through runGate: held → decided red, preflight never called; the probe token in no request', async (t) => {
  if (!shared) return t.skip(`${VECTORS} not present — the shared vectors UNVERIFIED here`);
  const MANIFEST = shared.vectors.find((v) => v.id === 'manifest_only').text;
  for (const v of shared.vectors) {
    const { dir, baseSha, headSha } = repoWith(MANIFEST, v.text);
    const sent = [];
    const check = {};
    // eslint-disable-next-line no-await-in-loop
    const res = await runGate({
      apiKey: 'k', apiUrl: 'https://x', githubToken: 't', owner: 'o', repo: 'r', baseSha, headSha, cwd: dir,
      preflightImpl: async (req) => { sent.push(JSON.stringify(req)); return {}; },
      postCheckRunImpl: async (c) => { Object.assign(check, c); return { ok: true, status: 201 }; },
      log: () => {},
    });
    // The no-send assertion first: on v0.11.4 this is the one that fails (the negative control).
    if (v.carries_token) assert.ok(!sent.some((s) => s.includes(shared.token)), `${v.id}: the probe token was sent`);
    if (HELD.has(v.kind)) {
      assert.equal(sent.length, 0, v.id);
      assert.equal(res.exitCode, 1, v.id);
      assert.equal(res.outcomeCode, 'MCP_JSON_HELD', v.id);
      assert.equal(check.conclusion, 'failure', v.id);
      assert.ok(String(check.summary || check.output && check.output.summary || JSON.stringify(check)).includes(CP.heldWhy('mcp.json', v.kind)), v.id);
    } else if (v.kind === 'client_config') {
      // P65c: the client side counts as no file — the manifest at base is decided as removed, without it.
      for (const req of sent) for (const a of JSON.parse(req).artifacts || []) assert.equal(a.after, '', v.id);
    }
  }
});

test('deriveArtifactsFromDiff: held sides are named, never an artifact', (t) => {
  if (!shared) return t.skip('shared vectors not present');
  for (const v of shared.vectors.filter((x) => HELD.has(x.kind))) {
    const impl = (args) => {
      if (args[0] === 'diff') return 'mcp.json\n';
      if (args[0] === 'rev-parse') return 'ok';
      if (args[0] === 'show') return args[1].startsWith('head:') ? v.text : '{"tools":[{"name":"a"}]}';
      return '';
    };
    const out = deriveArtifactsFromDiff({ baseRef: 'base', headRef: 'head', gitImpl: impl });
    assert.deepEqual(out.artifacts, [], v.id);
    assert.deepEqual(out.held, [{ path: 'mcp.json', kind: v.kind, why: CP.heldWhy('mcp.json', v.kind) }], v.id);
  }
});
