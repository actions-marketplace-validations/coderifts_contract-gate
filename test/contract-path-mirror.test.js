'use strict';
/**
 * The vendored classifier must answer identically to the real @coderifts/contract-path.
 * If this fails, src/contract-path.js has become the "second list" the package forbids.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const mine = require('../src/contract-path.js');

const REAL = path.join(process.env.HOME, 'coderifts-app', 'packages', 'contract-path', 'index.cjs');
let real = null;
try { real = require(REAL); } catch { /* reported by the skip below, never silently */ }

const CORPUS = [
  'openapi.yaml', 'openapi.yml', 'api/openapi.json', 'swagger.json', 'docs/swagger-v2.yaml',
  'asyncapi.yaml', 'events/asyncapi.json', 'schema.graphql', 'schema.gql', 'proto/user.proto',
  'mcp.json', '.well-known/mcp.json', 'config/mcp.json', 'tools-catalog.json', 'mcp-manifest.json',
  // P65: the MCP client configuration names, which both copies must refuse alike
  '.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', 'claude_desktop_config.json', 'cline_mcp_settings.json', 'mcp/tools.json',
  'package.json', 'tsconfig.json', 'package-lock.json', '.github/workflows/ci.yml',
  'README.md', 'src/index.js', 'node_modules/x/openapi.yaml', 'vendor/openapi.yaml',
  'openapi', 'a/b/c/openapi.yaml', 'OPENAPI.YAML', 'deep/nested/mcp/servers.json',
];

test('MIRROR: looksLikeContractPath matches the real package on the whole corpus', (t) => {
  if (!real) return t.skip('coderifts-app/packages/contract-path not present — mirror UNVERIFIED');
  for (const p of CORPUS) {
    assert.equal(mine.looksLikeContractPath(p), real.looksLikeContractPath(p), `looksLikeContractPath(${p})`);
  }
});

test('MIRROR: typeForPath matches the real package on every contract path', (t) => {
  if (!real) return t.skip('coderifts-app/packages/contract-path not present — mirror UNVERIFIED');
  for (const p of CORPUS.filter((x) => mine.looksLikeContractPath(x))) {
    assert.equal(mine.typeForPath(p), real.typeForPath(p), `typeForPath(${p})`);
  }
});

test('the honest edges hold: build files are not contracts, vendored paths are excluded', () => {
  for (const p of ['package.json', 'tsconfig.json', 'package-lock.json', '.github/workflows/ci.yml']) {
    assert.equal(mine.looksLikeContractPath(p), false, p);
  }
  assert.equal(mine.looksLikeContractPath('node_modules/x/openapi.yaml'), false);
  assert.equal(mine.looksLikeContractPath('vendor/openapi.yaml'), false);
});

test('MIRROR: the MCP client configuration pattern is the package\'s, character for character', (t) => {
  if (!real) return t.skip('coderifts-app/packages/contract-path not present — mirror UNVERIFIED');
  assert.equal(String(mine.MCP_CLIENT_CONFIG), String(real.MCP_CLIENT_CONFIG));
  assert.equal(String(mine.MCP_JSON_BY_CONTENT), String(real.MCP_JSON_BY_CONTENT));
});

test('MIRROR (P65c): the content decision answers as the package does on a corpus', (t) => {
  if (!real) return t.skip('coderifts-app/packages/contract-path not present — mirror UNVERIFIED');
  const texts = [
    JSON.stringify({ mcpServers: { a: { command: 'x', env: { T: '1' } } } }),
    JSON.stringify({ servers: { a: { type: 'stdio' } } }),
    JSON.stringify({ tools: [{ name: 'a' }] }),
    JSON.stringify({ mcpServers: {}, tools: [] }),
    JSON.stringify({ servers: [{ url: 'x' }] }),
    JSON.stringify({ mcpServers: 'x' }),
    '\uFEFF{"mcpServers":{}}', '{ broken', '[]', '{}', 'null', '', '{"mcpServers":{} // c\n}',
  ];
  const paths = ['mcp.json', '.well-known/mcp.json', 'a/./b/../mcp.json', '.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json',
    'mcp-tool-manifest.json', 'mcp/tools.json', 'x\\mcp.json'];
  for (const text of texts) {
    assert.equal(mine.mcpJsonKind(text), real.mcpJsonKind(text), `mcpJsonKind(${JSON.stringify(text)})`);
    for (const p of paths) assert.equal(mine.isClientConfigContent(p, text), real.isClientConfigContent(p, text), `isClientConfigContent(${p}, ${JSON.stringify(text)})`);
  }
});
