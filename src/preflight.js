'use strict';

/**
 * POST /api/v1/preflight — the v4 (envelope-bound) receipt path. NOT /api/diff, whose v3 receipt is
 * unbound to a change-set body_hash. Fail-closed: any non-2xx or unparseable body throws (the
 * orchestrator turns a throw into a FAIL check).
 */

const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Decision Spec 2.0 request body. Gate ENFORCES a merge (needs a signed receipt) → authorize.
 * Source binding slots are context.head / context.base (producer ID686) — not context.revision.
 *
 * @param {object} o
 * @param {Array} o.artifacts
 * @param {object} [o.context]
 * @param {'analyze'|'authorize'} [o.preflight_mode='authorize']
 * @returns {object}
 */
function buildPreflightRequest({ artifacts, context = {}, preflight_mode = 'authorize' } = {}) {
  return { artifacts, preflight_mode, context };
}

/**
 * The authorize request the server will bind. A missing slot is named and must not be sent:
 * without preflight_mode authorize, repository, base, and head, the server ignores control_plane
 * artifacts. operation must be merge.
 * @returns {null|'preflight_mode'|'repository'|'base'|'head'|'operation'}
 */
function missingAuthorizeSlot({ artifacts, context, preflight_mode } = {}) {
  void artifacts;
  const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
  if (preflight_mode !== 'authorize') return 'preflight_mode';
  const ctx = context || {};
  if (!nonEmpty(ctx.repository) || !/^[^/\s]+\/[^/\s]+$/.test(ctx.repository)) return 'repository';
  if (!nonEmpty(ctx.base)) return 'base';
  if (!nonEmpty(ctx.head)) return 'head';
  if (ctx.operation !== 'merge') return 'operation';
  return null;
}

/**
 * @param {object} o
 * @param {string} o.apiKey
 * @param {string} o.apiUrl               base URL, e.g. https://app.coderifts.com
 * @param {Array}  o.artifacts            diff-derived artifacts (NEVER caller-supplied)
 * @param {object} [o.context]            preflight context (operation/environment/repository/base/head)
 * @param {'analyze'|'authorize'} [o.preflight_mode='authorize']
 * @param {typeof fetch} [o.fetchImpl]    injectable fetch (tests)
 * @param {number} [o.timeoutMs]
 * @returns {Promise<object>} parsed preflight response
 */
async function callPreflight({
  apiKey, apiUrl, artifacts, context = {}, preflight_mode = 'authorize',
  fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!apiKey) throw new Error('callPreflight: apiKey is required');
  if (!apiUrl) throw new Error('callPreflight: apiUrl is required');
  if (!Array.isArray(artifacts)) throw new Error('callPreflight: artifacts must be an array');

  const url = `${apiUrl.replace(/\/+$/, '')}/api/v1/preflight`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildPreflightRequest({ artifacts, context, preflight_mode })),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res || typeof res.status !== 'number') throw new Error('callPreflight: no response');
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`preflight HTTP ${res.status}: ${String(text).slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error('preflight: response was not JSON');
  }
}

module.exports = { callPreflight, buildPreflightRequest, missingAuthorizeSlot, DEFAULT_TIMEOUT_MS };
