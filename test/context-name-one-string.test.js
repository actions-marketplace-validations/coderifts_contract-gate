'use strict';

/**
 * The reader's required context is ONE string (2026-09-28).
 *
 * Measured on coderifts/demo: PR #20–#23 (2026-09-21…24) carried `CodeRifts / contract-gate` from the
 * App (2860592); PR #4 re-run and PR #24 (2026-09-28) carry `CodeRifts / issuer` from the App and no
 * `CodeRifts / contract-gate` from anyone. The demo enforces with its aggregator JOB
 * `contract-gate (required)` (Actions, 15368) — #4 BLOCKED — while every doc told operators to require
 * `CodeRifts / contract-gate`, a name nobody posted.
 *
 * Decided, measured: the aggregator job (the shape that is measured enforcing) carries the documented
 * name verbatim, `if: always()`, and the gate step does not post its own check under the same name.
 * Held here: CHECK_NAME, the action.yml default, the template's required job name and every
 * ruleset/protection body in the docs are the same string beside `CodeRifts / issuer`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CHECK_NAME } = require('../src/check-run');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const ISSUER = 'CodeRifts / issuer';
const ALLOWED = new Set([CHECK_NAME, ISSUER]);

/** Uncommented YAML only: the template explains the old route in comments, and that is fine. */
const liveYaml = (y) => y.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#.*$/, '')).join('\n');

/** Jobs of a workflow as { id, name, body } from uncommented YAML (two-space job indentation). */
function jobsOf(yamlText) {
  const w = liveYaml(yamlText);
  const start = w.indexOf('\njobs:\n');
  assert.ok(start >= 0, 'no jobs: block');
  const parts = w.slice(start + 7).split(/\n(?=  [A-Za-z0-9_-]+:\s*$)/m);
  return parts.map((p) => {
    const id = /^\s{2}([A-Za-z0-9_-]+):/m.exec(p);
    const name = /^\s{4}name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(p);
    return { id: id && id[1], name: name ? name[1] : (id && id[1]), body: p };
  }).filter((j) => j.id);
}

/** Every required-context string in a doc's JSON bodies, except in a block labelled as history. */
function contextsIn(doc) {
  const out = [];
  let history = 0;
  for (const line of doc.split('\n')) {
    if (/before the rename/.test(line)) { history = 4; continue; }
    if (history > 0) { history -= 1; continue; }
    for (const m of line.matchAll(/"context"\s*:\s*"([^"]+)"/g)) out.push(m[1]);
    const arr = /"contexts"\s*:\s*\[([^\]]*)\]/.exec(line);
    if (arr) for (const m of arr[1].matchAll(/"([^"]+)"/g)) out.push(m[1]);
  }
  return out;
}

test('⚠⚠ CHECK_NAME and the action.yml check-name default are one string', () => {
  assert.equal(CHECK_NAME, 'CodeRifts / contract-gate');
  const yml = read('action.yml');
  const block = yml.slice(yml.indexOf('check-name:'), yml.indexOf('post-check-run:'));
  assert.ok(block.includes(`default: '${CHECK_NAME}'`), block);
});

test('⚠⚠ exactly one template job carries CHECK_NAME, and it is an always() aggregator that fails on non-success', () => {
  const jobs = jobsOf(read('examples/contract-gate.yml'));
  const named = jobs.filter((j) => j.name === CHECK_NAME);
  assert.equal(named.length, 1, `jobs named ${CHECK_NAME}: ${named.map((j) => j.id).join(', ')}`);
  const agg = named[0].body;
  assert.match(agg, /if:\s*always\(\)/, 'without always() the aggregator is skipped with its dependency, and skipped passes');
  assert.match(agg, /needs:\s*\[/);
  assert.match(agg, /=\s*"success"\s*\]\s*\|\|\s*exit 1/, 'the aggregator must fail on anything that is not success');
  assert.ok(!jobs.some((j) => j.name === 'contract-gate (required)'), 'the old aggregator name is retired');
});

test('⚠⚠ the gate step does not post a second check under the same name', () => {
  const w = liveYaml(read('examples/contract-gate.yml'));
  assert.match(w, /post-check-run:\s*'false'/, 'the aggregator carries the name; the action must not post it too');
  assert.ok(!/check-name:/.test(w), 'the template does not rename the action check');
});

for (const doc of ['ENFORCEMENT.md', 'docs/ENFORCEMENT-RUNBOOK.md']) {
  test(`⚠⚠ every ruleset / protection context in ${doc} is one of the two strings`, () => {
    const found = contextsIn(read(doc));
    const stray = found.filter((c) => !ALLOWED.has(c));
    assert.deepEqual(stray, [], `${doc} requires a context nothing posts: ${stray.join(' · ')}`);
    assert.ok(found.includes(CHECK_NAME) && found.includes(ISSUER), `${doc} must name both contexts`);
  });
}

test('the setup script requires the same two strings', () => {
  const s = read('scripts/require-contract-gate.sh');
  assert.ok(s.includes(`CONTEXT="${CHECK_NAME}"`) && s.includes(`ISSUER_CONTEXT="${ISSUER}"`));
});

test('the transition is stated where an operator configures it', () => {
  for (const doc of ['ENFORCEMENT.md', 'docs/ENFORCEMENT-RUNBOOK.md', 'examples/contract-gate.yml']) {
    const d = read(doc).replace(/\s*\n\s*#?\s*/g, ' ');
    assert.match(d, /no longer posts `CodeRifts \/ contract-gate`/, `${doc} must say the App stopped posting the old name`);
    assert.ok(d.includes('2860592') && d.includes('15368'), `${doc} must name both integration ids`);
  }
});
