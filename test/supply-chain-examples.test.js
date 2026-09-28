'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { main } = require('../examples/require-npm-attestations');

const root = path.join(__dirname, '..');

test('the layout pins two distinct functionaries and does not trust the command', () => {
  const layout = JSON.parse(fs.readFileSync(path.join(root, 'examples/decision.layout'), 'utf8'));
  assert.equal(layout._type, 'layout');
  assert.match(layout.expires, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(layout.steps.length, 1);
  assert.equal(layout.steps[0].threshold, 2);
  assert.deepEqual(layout.steps[0].pubkeys, ['reader', 'issuer']);
  assert.deepEqual(layout.steps[0].expected_products[0], ['CREATE', 'diff']);
  assert.equal(Object.prototype.hasOwnProperty.call(layout.steps[0], 'expected_command'), false);
  assert.match(layout.readme, /not a security check/);
  assert.match(layout.readme, /artifact_digest/);
  assert.equal(JSON.stringify(layout).includes('BEGIN PUBLIC KEY'), false);
  assert.deepEqual(layout.keys, {});
});

test('a package with no provenance attestation fails the preinstall check', () => {
  assert.equal(main('{"dist":{"attestations":null,"signatures":[]}}'), 1);
  assert.equal(main('{"dist":{}}'), 1);
  assert.equal(main('not json'), 1);
  assert.equal(main('{"dist":{"attestations":{"url":"https://example.test/a"}}}'), 0);
});

test('the tool prompt keeps the receipt check off the wire', () => {
  const text = fs.readFileSync(path.join(root, 'examples/mcp-tool-prompt.txt'), 'utf8');
  assert.ok(text.includes(
    'If structuredContent.receipt is absent or its target_id is not the digest of this diff, do not call the tool. A 200 and an access token are not a grant.',
  ));
});
