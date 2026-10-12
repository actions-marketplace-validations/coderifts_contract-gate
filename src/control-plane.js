'use strict';

/**
 * Control-plane paths. This action had no list of its own.
 *
 * Read 2026-10-12 from coderifts-app, not imported (the action does not depend on the app):
 *   src/mergegate/control-plane.js classifyControlPlanePath, lines 58-100.
 *   isWorkflowFile (quoted 2026-10-11 from src/actionguard/webhook-integration.js):
 *     /^\.github\/workflows\/[^/]+\.ya?ml$/
 *   The 2026-10-12 read adds coderifts-audit.yaml (line 85), keyring/pinned-keys.json (line 96),
 *   a root action.yml|yaml (line 97), and .github/actions/** (line 98).
 *   CODEOWNERS is not in that function. This file does not add it.
 */

const { blobAt } = require('./artifacts');

function normalizeRepoPath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  if (s.startsWith('/')) s = s.slice(1);
  return s;
}

function isWorkflowFile(p) {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(String(p || ''));
}

/**
 * @param {unknown} path
 * @returns {{ control_plane: boolean, class: string|null, path: string }}
 */
function classifyControlPlanePath(filePath) {
  const p = normalizeRepoPath(filePath);
  if (!p) return { control_plane: false, class: null, path: p };

  if (p === '.coderifts.yml' || p === '.coderifts.yaml') {
    return { control_plane: true, class: 'approver_config', path: p };
  }
  if (isWorkflowFile(p)) {
    return { control_plane: true, class: 'ci_workflow', path: p };
  }
  if (
    p.startsWith('.coderifts/keys/')
    || p.startsWith('.coderifts/trust/')
    || p.startsWith('.coderifts/signing/')
  ) {
    return { control_plane: true, class: 'trust_anchor', path: p };
  }
  if (p.startsWith('.coderifts/') && /\.(pem|pub)$/i.test(p)) {
    return { control_plane: true, class: 'trust_anchor', path: p };
  }
  if (
    p === '.coderifts/audit.yml'
    || p === '.coderifts/audit.yaml'
    || p === 'coderifts-audit.yml'
    || p === 'coderifts-audit.yaml'
  ) {
    return { control_plane: true, class: 'audit_config', path: p };
  }

  // 5) 2026-10-12 — same three lines as coderifts-app src/mergegate/control-plane.js:96-98.
  if (p === 'keyring/pinned-keys.json') return { control_plane: true, class: 'trust_anchor', path: p };
  if (p === 'action.yml' || p === 'action.yaml') return { control_plane: true, class: 'ci_workflow', path: p };
  if (p.startsWith('.github/actions/')) return { control_plane: true, class: 'ci_workflow', path: p };

  return { control_plane: false, class: null, path: p };
}

/**
 * Keys and signing material are sent as a path only. before and after stay "".
 * The checkout text is never placed on the request.
 * @param {string} p normalized repo path
 * @returns {boolean}
 */
function isPathOnlyControlPlane(p) {
  return p.startsWith('.coderifts/keys/')
    || p.startsWith('.coderifts/trust/')
    || p.startsWith('.coderifts/signing/')
    || (p.startsWith('.coderifts/') && /\.(pem|pub)$/i.test(p));
}

/**
 * Changed paths with renames broken into a delete plus an add.
 * `git diff -z --no-renames --name-only <base> <head>`.
 * @returns {string[]}
 */
function changedPathsNoRenames(baseRef, headRef, cwd, gitImpl) {
  const out = gitImpl(['diff', '-z', '--no-renames', '--name-only', baseRef, headRef], cwd);
  return String(out == null ? '' : out).split('\0').map((s) => s.trim()).filter(Boolean);
}

/**
 * One control_plane artifact per changed control-plane path.
 * A missing side is "". A path-only key or signing file is "" / "" and is not read.
 * @returns {{ matched: Array<{ path: string, class: string }>, artifacts: Array<{id:string,type:string,before:string,after:string}> }}
 */
function deriveControlPlaneArtifacts({ baseRef, headRef, cwd = process.cwd(), gitImpl }) {
  if (!baseRef || !headRef) throw new Error('deriveControlPlaneArtifacts: baseRef and headRef are required');
  if (typeof gitImpl !== 'function') throw new Error('deriveControlPlaneArtifacts: gitImpl is required');
  const matched = [];
  const artifacts = [];
  for (const raw of changedPathsNoRenames(baseRef, headRef, cwd, gitImpl)) {
    const c = classifyControlPlanePath(raw);
    if (!c.control_plane) continue;
    let before = '';
    let after = '';
    if (!isPathOnlyControlPlane(c.path)) {
      const beforeRaw = blobAt(baseRef, c.path, cwd, gitImpl);
      const afterRaw = blobAt(headRef, c.path, cwd, gitImpl);
      before = beforeRaw == null ? '' : String(beforeRaw);
      after = afterRaw == null ? '' : String(afterRaw);
      if (before === after) continue;
    }
    matched.push({ path: c.path, class: c.class });
    artifacts.push({ id: c.path, type: 'control_plane', before, after });
  }
  return { matched, artifacts };
}

/**
 * @param {Array<string|{filename?: string}>|null|undefined} filesOrPaths
 * @returns {{ control_plane: boolean, matched: Array<{ path: string, class: string }> }}
 */
function summarizeControlPlane(filesOrPaths) {
  const matched = [];
  const list = Array.isArray(filesOrPaths) ? filesOrPaths : [];
  for (const item of list) {
    const raw = typeof item === 'string' ? item : (item && item.filename);
    const c = classifyControlPlanePath(raw);
    if (c.control_plane) matched.push({ path: c.path, class: c.class });
  }
  return { control_plane: matched.length > 0, matched };
}

module.exports = {
  normalizeRepoPath,
  isWorkflowFile,
  classifyControlPlanePath,
  summarizeControlPlane,
  isPathOnlyControlPlane,
  deriveControlPlaneArtifacts,
};
