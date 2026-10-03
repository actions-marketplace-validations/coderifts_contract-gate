# CodeRifts Contract Gate

The suggested setup: a pull request's real contract diff does not merge without a signed receipt, verified on the runner. Two contexts are required, `CodeRifts / contract-gate` and `CodeRifts / issuer`. One of them alone is not the gate.

The Action posts a check. Branch protection is what blocks the merge ([ENFORCEMENT.md](ENFORCEMENT.md)). On its own the check does not. A repository admin with `enforce_admins: false` can still merge past it ([SECURITY.md](SECURITY.md)). This gate is distinct from [`coderifts/action`](https://github.com/coderifts/action), which posts an advisory pull-request comment.

## Usage

This is [`examples/contract-gate.yml`](examples/contract-gate.yml). The aggregator job is named `CodeRifts / contract-gate` and runs `if: always()`. The Action sets `post-check-run: 'false'`.

```yaml
# Copy this to `.github/workflows/contract-gate.yml` in YOUR repository.
#
# It runs the CodeRifts contract gate on every pull request. The required context is the JOB named
# EXACTLY:  CodeRifts / contract-gate      (posted by GitHub Actions, integration_id 15368)
# And the App check: CodeRifts / issuer     (posted by the CodeRifts App, integration_id 2860592)
# Make BOTH strings required status checks (see ENFORCEMENT.md). One of them alone is not the gate.
#
# ⚠ TRANSITION (2026-09-28): the CodeRifts App no longer posts `CodeRifts / contract-gate`; it
# posts `CodeRifts / issuer`. If your ruleset required `CodeRifts / contract-gate` bound to the App
# (2860592), replace it with `CodeRifts / issuer` bound to 2860592 and add
# `CodeRifts / contract-gate` bound to 15368 — this workflow's job below.
name: CodeRifts Contract Gate

# Run on EVERY pull request to the protected branch. Do NOT add `paths:` filters — a path filter
# would skip contract PRs the filter doesn't match, and a required check that never runs leaves the
# PR mergeable with the check "pending" (see ENFORCEMENT.md, "fail-closed on absence").
# merge_group is a different commit from the PR head. A required check that only listens to
# pull_request is never reported on the queue, and GitHub then refuses the merge.
on:
  pull_request:
  merge_group:

# Least privilege: write checks (to post the Check Run) + read the code (to derive the diff).
permissions:
  checks: write
  contents: read

jobs:
  contract-gate-action:
    name: contract-gate (Action)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # REQUIRED: the gate derives the change set from `git diff base...head`, so the full
          # history (both sides of the diff) must be present locally.
          fetch-depth: 0

      - uses: coderifts/contract-gate@v0
        with:
          api-key: ${{ secrets.CODERIFTS_API_KEY }}
          # The job below carries the required name. If the action posted its own check under the
          # same name, one context would have two check-runs from one poster.
          post-check-run: 'false'
          # api-url: https://app.coderifts.com   # override only for self-hosted
          #
          # Optional — require a signed CWM delivery attestation (guard ≥9.2.0).
          # The host signs with a customer-held monitoring key; this action
          # verifies the token OFFLINE against a local keyring file (no fetch).
          # require-verified-monitoring: 'true'
          # monitoring-attestation: ${{ vars.CODERIFTS_MONITORING_ATTESTATION }}
          # monitoring-keyring: ${{ github.workspace }}/.coderifts/monitoring-keys.json

  contract-gate:
    name: "CodeRifts / contract-gate"     # ← the required context, verbatim
    needs: [contract-gate-action]
    # ⚠ `always()` IS THE LOAD-BEARING WORD. Without it this job is itself SKIPPED whenever the
    # job it needs was skipped, cancelled or failed — and a skipped required check passes.
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: the gate ran and succeeded — skipped is not success
        env:
          GATE_RESULT: ${{ needs.contract-gate-action.result }}
        run: |
          echo "contract-gate-action result: $GATE_RESULT"
          # success | failure | cancelled | skipped — only the first is a pass.
          [ "$GATE_RESULT" = "success" ] || exit 1

# ─────────────────────────────────────────────────────────────────────────────────────────────
# ⚠ WHY THE REQUIRED CONTEXT IS A JOB WITH `always()`, AND NOT THE ACTION'S OWN CHECK-RUN.
#
# GitHub's rule, measured on coderifts/demo 2026-09-23 (the `canary` job concluded `skipped`):
# "Required status checks must have a `successful`, `skipped`, or `neutral` status before
# collaborators can make changes to a protected branch." A skipped required check PASSES. The job
# above runs even when the gate job was skipped, cancelled or timed out, and turns anything that
# is not `success` into a failure — measured enforcing on coderifts/demo PR #4 (BLOCKED).
#
# ⚠ `[skip coderifts]` needs no help: the action refuses the request and concludes `failure`
# (src/explicit-skip.js, outcome EXPLICIT_SKIP_NOT_ALLOWED), because a neutral would leave the
# pull request mergeable.
```

Branch protection, on the protected branch: require status checks, and add both `CodeRifts / contract-gate` and `CodeRifts / issuer`. The UI steps and the script are in [ENFORCEMENT.md](ENFORCEMENT.md). The same pair is the recipe on <https://coderifts.com/docs/hosts/mcp-server/> and on <https://coderifts.com/install/>.

## What it does

The default is `profile: enforcing`.

- A head commit that carries a `CodeRifts-Receipt` trailer and a `.coderifts/receipts/<sha>.json` sidecar is verified offline against the pinned keyring. That run does not call preflight.
- With no trailer and no sidecar, the gate issues a receipt, verifies that receipt offline, and writes it to the check summary. The receipt is never written onto the commit.

> **CWM honesty.** With `require_verified_monitoring: true` the gate verifies a `cr.monitor.attest.v1` token offline against a pinned monitoring keyring (CWM passes only on `delivered_acked`); by default it passes CWM on the host's claim. The token proves a monitoring-key holder observed the delivery — not that a human read it, not that the sink targets the right audience. Unsigned JSON is not accepted under the flag.

## Requiring the receipt on the head commit (`require-receipt-trailer`)

Off by default. With `require-receipt-trailer: 'true'` the gate additionally requires the receipt
that was **attached to the head commit**, and checks it offline before any API call:

- **Carrier.** A `CodeRifts-Receipt: <token>` trailer in the head commit message, and/or a
  `.coderifts/receipts/<head-sha>.json` sidecar `{ "receipt": "<token>", "envelope": { … } }` in the
  workspace. Both present and different → failure (neither is used).
- **Authentic.** The token verifies against the **pinned keyring** with the vendored verifier.
- **This diff.** The signed envelope's `artifact_digest` must equal the digest the gate computes from
  the pull request's actual contract diff (sha256 over each artifact's before/after bytes, sorted by
  type and id — the recipe the CodeRifts API signs).
- **An ALLOW.** The envelope's `execution_action` must be `CONTINUE`.

The envelope is required: a trailer carries only the token, which proves the receipt is authentic
but not which diff it covers, so **a trailer on its own fails** (`receipt_envelope_required`). A
sidecar keyed by the head SHA cannot live inside the head commit (the SHA would change) — write it
into the workspace in a step before the gate.

Missing, conflicting, unauthentic, a different diff, or not an ALLOW → the check fails, with the
reason (`receipt_trailer_missing`, `receipt_trailer_conflict`, `receipt_trailer_invalid`,
`receipt_diff_mismatch`, `receipt_not_allow`, `receipt_envelope_required`) in the summary.

```yaml
      - uses: coderifts/contract-gate@v0
        with:
          api-key: ${{ secrets.CODERIFTS_API_KEY }}
          require-receipt-trailer: 'true'
```

## Trust model — pinned keyring

The gate ships a **pinned public keyring** and verifies **offline** against it. It never trusts the
server under test to supply its own verification key.

- **Trust-on-first-pin.** `keyring/pinned-keys.json` was pinned from
  `GET /api/v1/attestation/public-key` at build time.
- **Currently pinned:** `kid = 2026-07-k1` (Ed25519).
- **Rotation is additive.** To rotate, open a PR that **adds** the new key entry to the keyring
  (both old and new keys remain valid for in-flight receipts). Never replace — replacing would
  reject receipts signed by the still-valid old key.
- The gate loads **only** this file. If a receipt's `kid` is not in the pinned keyring, verification
  fails closed (`UNKNOWN_KEY`). The network key-fetch fallback is not used on the gate path.

## Contract file classification

Changed files are classified into preflight artifact types: `openapi`/`swagger` (`*.yaml|json`,
`*-api.*`, `api/*`), `graphql` (`*.graphql|gql`), `grpc` (`*.proto`), `asyncapi`, `mcp_manifest`.
A diff that changes no contract file passes with `no_contract_changes` (nothing to govern).

## Dependencies

Zero runtime dependencies — Node builtins only, plus a vendored, byte-identical copy of the frozen
receipt verifier (`src/verify.js` and `src/arity.js`, from `receipt-verifier`). Minimal supply-chain
surface for a security gate. The copied revision and the SHA-256 of each file are recorded in
[`VENDOR.md`](VENDOR.md) and `src/VENDOR.sha256`; `test/vendor-core.test.js` fails if either file
drifts from its pin, and separately re-checks the key-status behaviour the pin exists to protect.

## single-check (legacy)

One job. The Action posts `CodeRifts / contract-gate` itself, because `post-check-run` is left at its default `true`. That is not the suggested setup. The suggested setup is the aggregator job above, with `post-check-run: 'false'`, and branch protection requiring both contexts.

```yaml
on: pull_request
jobs:
  contract-gate:
    runs-on: ubuntu-latest
    permissions:
      checks: write
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # required: base..head must be available locally
      - uses: coderifts/contract-gate@v0
        with:
          api-key: ${{ secrets.CODERIFTS_API_KEY }}
          # Optional: require a signed monitoring-delivery attestation on CWM
          # require-verified-monitoring: 'true'
          # monitoring-attestation: ${{ vars.CODERIFTS_MONITORING_ATTESTATION }}
          # monitoring-keyring: ${{ github.workspace }}/.coderifts/monitoring-keys.json
```

## Releasing

This Action is consumed by tag, not from a registry: a release is a `package.json` bump in its own
commit, a `vX.Y.Z` tag, and moving the floating `v0` tag. Nothing in that path reads `CHANGELOG.md`,
which is how `v0.5.0`, `v0.6.0` and `v0.7.0` were each tagged with no section — two of them without
GitHub release notes either, leaving `git log` as the only record.

Before tagging:

```bash
npm run release:check   # fails if CHANGELOG.md has no "## <package.json version>" heading
```

CI runs the same check on every push and pull request, so a bump commit that omits the section fails
when it lands rather than at tag time.
