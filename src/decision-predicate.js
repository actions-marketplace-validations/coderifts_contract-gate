'use strict';

/**
 * The predicate GitHub artifact attestations and a Kyverno policy both read.
 * The four fields are copied off a receipt the gate already verified. This file
 * does not sign anything and does not add a field to the receipt.
 */

const fs = require('node:fs');

const PREDICATE_TYPE = 'https://coderifts.com/attestations/decision/v1';

function buildDecisionPredicate({ executionAction, operation, targetId, expiresAt } = {}) {
  return {
    execution_action: executionAction || null,
    operation: operation || null,
    target_id: targetId || null,
    expires_at: expiresAt || null,
  };
}

function writeDecisionPredicate(predicatePath, judgement) {
  if (!predicatePath || !judgement || judgement.ok !== true) return null;
  const env = judgement.envelope || {};
  const payload = judgement.payload || {};
  const predicate = buildDecisionPredicate({
    executionAction: env.execution_action,
    operation: env.operation,
    targetId: env.target_id || env.artifact_digest,
    expiresAt: (payload && payload.expires_at) || env.expires_at || null,
  });
  fs.writeFileSync(predicatePath, JSON.stringify(predicate) + '\n');
  return predicate;
}

module.exports = { PREDICATE_TYPE, buildDecisionPredicate, writeDecisionPredicate };
