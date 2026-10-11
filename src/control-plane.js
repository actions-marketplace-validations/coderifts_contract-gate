'use strict';

/**
 * Control-plane paths. This action had no list of its own.
 *
 * Read 2026-10-11 from coderifts-app, not imported (the action does not depend on the app):
 *   src/mergegate/control-plane.js — classifyControlPlanePath
 *   src/actionguard/webhook-integration.js — isWorkflowFile
 *     /^\.github\/workflows\/[^/]+\.ya?ml$/
 *   DECISIONS.md, "A control-plane change is never neutral (2026-10-11)":
 *     ".coderifts.yml/.coderifts.yaml, .github/workflows/*.yml|yaml,
 *      .coderifts/{keys,trust,signing}/ and .pem/.pub under .coderifts/,
 *      .coderifts/audit.yml, coderifts-audit.yml"
 * The function also classifies .coderifts/audit.yaml. That path is included here.
 */

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
  if (p === '.coderifts/audit.yml' || p === '.coderifts/audit.yaml' || p === 'coderifts-audit.yml') {
    return { control_plane: true, class: 'audit_config', path: p };
  }
  return { control_plane: false, class: null, path: p };
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
};
