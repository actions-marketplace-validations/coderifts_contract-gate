/**
 * VENDORED MIRROR of @coderifts/contract-path@1.3.0 (coderifts-app/packages/contract-path).
 *
 * That package's own header says: "Gate-path contract-file classifier (single list) … Do not
 * invent a second glob/list." This file is NOT a second list — it is a byte-faithful copy of the
 * one list, kept honest by test/contract-path-mirror.test.js, which classifies a corpus through
 * BOTH this copy and the real package and asserts identical answers. If they ever diverge, the
 * suite fails.
 *
 * WHY VENDORED RATHER THAN DEPENDED ON: this repo is a GitHub Action with
 * `using: node20, main: src/index.js`. Actions do not run `npm install` at dispatch, and this
 * repo does not commit node_modules (.gitignore). A runtime dependency would therefore have to be
 * committed or bundled — a packaging change to a published Action. Same trade-off, and same
 * mitigation (a drift test), as the scope-hash mirror in grant-coverage.js.
 */
'use strict';

const CONTRACT_EXT = /\.(ya?ml|json|graphql|gql|proto)$/i;
// P65 (2026-10-06): @coderifts/contract-path 1.2.0's MCP_CLIENT_CONFIG (from its contract-write), mirrored
// like the rest of this file: an MCP client configuration is never a contract, by name. The mirror test
// classifies the client-config names through both copies, so a drift fails the suite.
// P65c (2026-10-07, 1.3.0): by name only the names that are a client configuration and nothing else; a
// plain `mcp.json` is a candidate, decided by content after the read (isClientConfigContent below,
// mirrored from the package's contract-write and held to it on a corpus by the mirror test).
const MCP_CLIENT_CONFIG = /(^|\/)(\.mcp\.json|\.cursor\/mcp\.json|\.vscode\/mcp\.json|claude_desktop_config\.json|(cline_)?mcp_settings\.json)$/i;
const MCP_JSON_BY_CONTENT = /(^|\/)mcp\.json$/i;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 'client_config' for a JSON object with mcpServers/servers (an object) and no tools; else 'contract'. */
function mcpJsonKind(text) {
  let doc;
  try {
    doc = JSON.parse(String(text == null ? '' : text).replace(/^\uFEFF/, ''));
  } catch {
    return 'contract';
  }
  if (!isObject(doc) || 'tools' in doc) return 'contract';
  return isObject(doc.mcpServers) || isObject(doc.servers) ? 'client_config' : 'contract';
}

/** contract-write's normalizePath: `a/./b/../c` → `a/c`, backslashes → slashes, no leading `./`. */
function normalizePath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const abs = s.startsWith('/');
  const out = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else if (seg !== '..' || !abs) out.push(seg);
  }
  return (abs ? '/' : '') + out.join('/');
}

/** True when `path` is decided by content and `text` (one present side) is an MCP client configuration. */
function isClientConfigContent(path, text) {
  if (typeof text !== 'string' || text === '') return false;
  const rel = normalizePath(path);
  return MCP_JSON_BY_CONTENT.test(rel) && !MCP_CLIENT_CONFIG.test(rel) && mcpJsonKind(text) === 'client_config';
}

function looksLikeContractPath(p) {
  const s = String(p || '').toLowerCase();
  if (s.includes('node_modules/') || s.includes('vendor/')) return false;
  if (MCP_CLIENT_CONFIG.test(s)) return false;
  return CONTRACT_EXT.test(s) && (s.includes('openapi') || s.includes('swagger') || s.includes('asyncapi')
    || s.endsWith('.graphql') || s.endsWith('.gql') || s.endsWith('.proto') || s.includes('mcp'));
}

function typeForPath(p) {
  const s = String(p).toLowerCase();
  if (s.endsWith('.graphql') || s.endsWith('.gql')) return 'graphql';
  if (s.endsWith('.proto')) return 'grpc';
  if (s.includes('asyncapi')) return 'asyncapi';
  if (s.includes('mcp')) return 'mcp_manifest';
  return 'openapi';
}

module.exports = {
  CONTRACT_EXT, MCP_CLIENT_CONFIG, MCP_JSON_BY_CONTENT, mcpJsonKind, isClientConfigContent, looksLikeContractPath, typeForPath,
};
