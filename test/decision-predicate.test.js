'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PREDICATE_TYPE, buildDecisionPredicate, writeDecisionPredicate } = require('../src/decision-predicate');

test('the predicate type is one frozen URI', () => {
  assert.equal(PREDICATE_TYPE, 'https://coderifts.com/attestations/decision/v1');
});

test('the predicate copies four fields and invents none', () => {
  const predicate = buildDecisionPredicate({
    executionAction: 'CONTINUE',
    operation: 'merge',
    targetId: 'sha256:' + 'ab'.repeat(32),
    expiresAt: '2027-01-01T00:00:00.000Z',
  });
  assert.deepEqual(Object.keys(predicate).sort(), [
    'execution_action', 'expires_at', 'operation', 'target_id',
  ]);
  assert.equal(predicate.execution_action, 'CONTINUE');
  assert.equal(predicate.operation, 'merge');
});

test('the attest workflow and the Kyverno policy name that same URI', () => {
  const root = path.join(__dirname, '..');
  const attest = fs.readFileSync(path.join(root, 'examples/attest-decision.yml'), 'utf8');
  const policy = fs.readFileSync(path.join(root, 'examples/kyverno-decision.yaml'), 'utf8');
  assert.ok(attest.includes(PREDICATE_TYPE));
  assert.ok(attest.includes('actions/attest@v4'));
  assert.ok(attest.includes('subject-digest:'));
  assert.ok(attest.includes('merge_group:'));
  assert.equal(attest.includes('push-to-registry: true'), false);
  assert.ok(policy.includes(PREDICATE_TYPE));
  assert.ok(policy.includes('failurePolicy: Fail'));
  assert.ok(policy.includes('validationFailureAction: Enforce'));
  assert.ok(policy.includes('background: false'));
  assert.ok(policy.includes('keyless:'));
  assert.equal(policy.includes('ignoreTlog'), false);
  assert.equal(policy.includes('BEGIN PUBLIC KEY'), false);
});

test('the predicate file is written only for a verified receipt and only when a path is given', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cr-predicate-'));
  const file = path.join(dir, 'decision-predicate.json');
  const digest = 'sha256:' + 'ab'.repeat(32);
  const written = writeDecisionPredicate(file, {
    ok: true,
    envelope: {
      execution_action: 'CONTINUE',
      operation: 'merge',
      artifact_digest: digest,
    },
    payload: { expires_at: '2027-01-01T00:00:00.000Z' },
  });
  assert.equal(written.target_id, digest);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), written);
  assert.equal(writeDecisionPredicate('', { ok: true, envelope: { artifact_digest: digest } }), null);
  assert.equal(writeDecisionPredicate(file, { ok: false, envelope: { artifact_digest: digest } }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the action writes that file only when the caller passes a path', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(src, /predicatePath = null/);
  assert.match(src, /predicatePath: predicatePathFromInput\(\)/);
  assert.equal((src.match(/writeDecisionPredicate\(predicatePath/g) || []).length, 2);
});
