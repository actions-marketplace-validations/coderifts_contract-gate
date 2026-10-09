'use strict';

/**
 * Derive the contract change set from the PR's ACTUAL head diff — NOT from any caller input.
 *
 * This is the anti-bypass core (Gap 5). An agent could otherwise submit the unchanged base spec to
 * get a clean receipt while merging something breaking. Here the artifacts are read straight from
 * git: the changed files between base and head, with before = base blob, after = head blob. There is
 * no code path that accepts caller-supplied artifacts.
 *
 * blobAt three-state convention (absent ≠ present ≠ unreadable):
 *   present   — string content (may be empty '')
 *   absent    — null (path not in the resolved ref's tree)
 *   unreadable — throws with code ARTIFACT_UNREADABLE (bad ref, corrupt object, other git errors)
 */

const { execFileSync } = require('node:child_process');

// changed-file path -> preflight artifact type. Conservative + explicit; a file that matches nothing
// is not a governed contract artifact and is ignored (it never changed a contract surface).
const CLASSIFIERS = [
  { type: 'openapi', re: /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i },
  { type: 'openapi', re: /(^|\/)[^/]*-api\.(ya?ml|json)$/i },
  { type: 'openapi', re: /(^|\/)api\/[^/]*\.(ya?ml|json)$/i },
  { type: 'asyncapi', re: /(^|\/)asyncapi[^/]*\.(ya?ml|json)$/i },
  { type: 'graphql', re: /\.(graphql|gql)$/i },
  { type: 'grpc', re: /\.proto$/i },
  { type: 'mcp_manifest', re: /(^|\/)(mcp[^/]*\.json|tools?-catalog\.json|mcp-manifest\.json)$/i },
];

// P65 (2026-10-06): an MCP client configuration (`.mcp.json`, `.cursor/mcp.json`, `mcp_settings.json` …,
// with the servers' env credentials) is never a contract artifact — the pattern of @coderifts/contract-path,
// mirrored in ./contract-path.js (drift-tested). Checked first, by name, so the file is never read from git.
// P65c (2026-10-07): a plain `mcp.json` is also a server's tool-manifest name, so it is read and decided by
// content (isClientConfigContent): a side that is a client configuration counts as no file, never sent.
const { MCP_CLIENT_CONFIG, isClientConfigContent, mcpJsonContentKind, heldWhy } = require('./contract-path.js');

function classify(path) {
  if (MCP_CLIENT_CONFIG.test(String(path || '').toLowerCase())) return null;
  for (const c of CLASSIFIERS) {
    if (c.re.test(path)) return c.type;
  }
  return null;
}

/** Default git runner: argv form (never a shell string) so a path can never become a command. */
function defaultGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Collect stderr/message text from a failed gitImpl / execFileSync error. */
function gitErrorText(err) {
  if (!err) return '';
  const parts = [err.stderr, err.message, err.stdout];
  return parts.map((p) => (p == null ? '' : String(p))).join('\n');
}

/**
 * True when git reports the path is missing at an already-resolved ref
 * (not a bad ref / corrupt object). Measured patterns:
 *   fatal: path 'X' does not exist in 'REF'
 *   fatal: path 'X' exists on disk, but not in 'REF'  (path absent from that tree)
 */
function isPathAbsentAtRef(err) {
  const text = gitErrorText(err);
  return /path ['"][^'"]+['"] does not exist in/.test(text)
    || /path ['"][^'"]+['"] exists on disk, but not in/.test(text);
}

/**
 * @param {string} ref
 * @param {string} filePath
 * @param {Error} cause
 * @param {string} [detail]
 * @returns {Error & { code: string, ref: string, path: string }}
 */
function artifactUnreadableError(ref, filePath, cause, detail) {
  const causeText = gitErrorText(cause).trim().split('\n')[0] || (cause && cause.message) || 'git error';
  const err = new Error(
    `artifact_unreadable: ${filePath} at ${ref}`
    + (detail ? ` (${detail})` : '')
    + `: ${causeText.slice(0, 240)}`,
  );
  err.code = 'ARTIFACT_UNREADABLE';
  err.ref = ref;
  err.path = filePath;
  err.cause = cause;
  return err;
}

/**
 * Read the blob at <ref>:<path>.
 *
 * Returns:
 *   - string  — present (including legitimate empty content '')
 *   - null    — absent (path not in the tree at ref)
 * Throws ARTIFACT_UNREADABLE when the ref cannot be resolved or git fails for a non-absent reason.
 *
 * Discrimination (measured): resolve ref with `git rev-parse --verify ref^{commit}` first so a
 * bogus object is never mistaken for a missing path; then `git show ref:path` — path-missing
 * stderr patterns → null; anything else → throw.
 */
function blobAt(ref, path, cwd, gitImpl) {
  try {
    gitImpl(['rev-parse', '--verify', `${ref}^{commit}`], cwd);
  } catch (err) {
    throw artifactUnreadableError(ref, path, err, 'bad_ref');
  }

  try {
    const content = gitImpl(['show', `${ref}:${path}`], cwd);
    // Successful show: present. Empty blob is '' (not absent).
    return content == null ? '' : String(content);
  } catch (err) {
    if (isPathAbsentAtRef(err)) return null;
    throw artifactUnreadableError(ref, path, err, 'git_show_failed');
  }
}

/**
 * Read one side; on unreadable, tag the side name for callers.
 * @returns {string|null}
 */
function blobAtSide(ref, path, cwd, gitImpl, side) {
  try {
    return blobAt(ref, path, cwd, gitImpl);
  } catch (err) {
    if (err && err.code === 'ARTIFACT_UNREADABLE') {
      err.side = side;
      throw err;
    }
    const wrapped = artifactUnreadableError(ref, path, err, side);
    wrapped.side = side;
    throw wrapped;
  }
}

/**
 * @param {object} o
 * @param {string} o.baseRef   base commit/ref (PR target)
 * @param {string} o.headRef   head commit/ref (PR source — the ACTUAL merge candidate)
 * @param {string} [o.cwd]     repo working directory
 * @param {(args:string[],cwd:string)=>string} [o.gitImpl]  injectable git (tests)
 * @returns {{ artifacts: Array<{id,type,before,after}>, changedContractFiles: string[], allChanged: string[], held: Array<{path,kind,why}> }}
 * @throws {Error} code ARTIFACT_UNREADABLE when a blob cannot be read (fail closed — no fabricated '')
 */
function deriveArtifactsFromDiff({ baseRef, headRef, cwd = process.cwd(), gitImpl = defaultGit }) {
  if (!baseRef || !headRef) throw new Error('deriveArtifactsFromDiff: baseRef and headRef are required');

  // Three-dot: files changed on head since the merge-base with base — i.e. exactly the PR's changes.
  const out = gitImpl(['diff', '--name-only', `${baseRef}...${headRef}`], cwd);
  const allChanged = out.split('\n').map((s) => s.trim()).filter(Boolean);

  const artifacts = [];
  const changedContractFiles = [];
  // P65d: a plain mcp.json side that is 'mixed' or 'unparseable' — never sent, and not "no file": runGate
  // decides red with its sentence before anything is sent.
  const held = [];
  for (const path of allChanged) {
    const type = classify(path);
    if (!type) continue;

    // Three-state reads: null = absent, string = present, throw = unreadable (not flattened to '').
    // P65c: a present side that is an MCP client configuration is absent (its text is never sent).
    const asContract = (raw) => (raw !== null && isClientConfigContent(path, raw) ? { raw: null, client: true } : { raw, client: false });
    const rawBefore = blobAtSide(baseRef, path, cwd, gitImpl, 'before');
    const rawAfter = blobAtSide(headRef, path, cwd, gitImpl, 'after');
    const heldKind = [rawBefore, rawAfter].map((t) => (t === null ? null : mcpJsonContentKind(path, t))).find((k) => k === 'mixed' || k === 'unparseable');
    if (heldKind) {
      held.push({ path, kind: heldKind, why: heldWhy(path, heldKind) });
      continue;
    }
    const b = asContract(rawBefore);
    const a = asContract(rawAfter);
    // Only a client configuration (or nothing) on both sides: not a contract file in this PR.
    if ((b.client || a.client) && b.raw === null && a.raw === null) continue;
    changedContractFiles.push(path);
    const beforeRaw = b.raw;
    const afterRaw = a.raw;

    // Preflight / NEW_ARTIFACT convention: absent maps to empty string for the wire shape only.
    // Unreadable never reaches here (thrown above).
    const before = beforeRaw === null ? '' : beforeRaw;
    const after = afterRaw === null ? '' : afterRaw;

    // A rename/no-op with identical bytes is not a material change; skip it.
    // Both-absent (null→'') also skips — nothing to compare.
    if (before === after) continue;
    artifacts.push({ id: path, type, before, after });
  }
  return { artifacts, changedContractFiles, allChanged, held };
}

module.exports = {
  deriveArtifactsFromDiff,
  classify,
  CLASSIFIERS,
  blobAt,
  defaultGit,
  isPathAbsentAtRef,
  artifactUnreadableError,
};
