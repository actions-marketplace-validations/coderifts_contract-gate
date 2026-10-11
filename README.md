# CodeRifts Contract Gate

The suggested setup: a pull request's real contract diff does not merge without a signed receipt, verified on the runner. Two contexts are required, `CodeRifts / contract-gate` and `CodeRifts / issuer`. One of them alone is not the gate.

The Action posts a check. Branch protection is what blocks the merge ([ENFORCEMENT.md](ENFORCEMENT.md)). On its own the check does not. A repository admin with `enforce_admins: false` can still merge past it ([SECURITY.md](SECURITY.md)). This gate is distinct from [`coderifts/action`](https://github.com/coderifts/action), which posts an advisory pull-request comment.

## Usage

This is [`examples/contract-gate.yml`](examples/contract-gate.yml). The aggregator job is named `CodeRifts / contract-gate` and runs `if: always()`. The Action sets `post-check-run: 'false'`.

The workflow's permissions are `contents: read` and `pull-requests: read`. `checks: write` is commented. Uncomment it only when `post-check-run` is left on: that is when `src/check-run.js` posts `POST /repos/{owner}/{repo}/check-runs`. The diff is read with local `git` (`src/artifacts.js` `defaultGit`, `execFileSync`). No file under `src/` calls the GitHub pulls API. `owner`, `repo`, `base`, and `head` come from `GITHUB_EVENT_PATH` (`readEvent`). `pull-requests: read` is in the block and this action does not use it.

The action appends the five receipt lines, the conclusion, the receipt id, `target_id`, `expires_at`, and the reason to `GITHUB_STEP_SUMMARY`, and sets job outputs `receipt-id`, `conclusion`, `reason`, and `title`. The aggregator step prints those outputs. The required context is that job, and a step cannot set the job check-run's `output` (title, summary, text). `post-check-run: false` still writes the step summary and the outputs; it only skips the action's own check-run. That opt-out logs `[check not posted — post-check-run:false] <conclusion>: <title> reason=<reason> receipt-id=<id or n/a>`. The step summary is not on the check-run API, and a STOP and a binding mismatch share the title. A missing id is `n/a`. The receipt id is `envelope.receipt_id` when that string is non-empty, otherwise `envelope.decision_id`. The issuer sets `decision_id`.

`actions/checkout` in the example is pinned to commit `11d5960a326750d5838078e36cf38b85af677262` (`# v4`). On 2026-10-11 `git ls-remote` resolved `refs/tags/v4` to that commit.

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

# Run on EVERY pull request to the protected branch. Do NOT add a path filter — a filter
# would skip contract PRs the filter doesn't match, and a required check that never runs leaves the
# PR mergeable with the check "pending" (see ENFORCEMENT.md, "fail-closed on absence").
# merge_group is a different commit from the PR head. A required check that only listens to
# pull_request is never reported on the queue, and GitHub then refuses the merge.
# The run's SHAs on that event are merge_group.base_sha and merge_group.head_sha. A trailer
# minted for the pull-request head names the pull-request SHAs, so base_mismatch or
# head_mismatch falls through to issuance when require-receipt-trailer is left false.
# With that input true, the mismatch stays a failure. repo_mismatch and mode_mismatch
# stay failures either way.
on:
  pull_request:
  merge_group:

# Suggested setup (post-check-run: 'false' below) does not post a check-run.
# contents: read — actions/checkout and the local git reads (src/artifacts.js defaultGit).
# pull-requests: read — the action does not call the pulls API. SHAs come from GITHUB_EVENT_PATH.
# Uncomment checks: write only when this action posts its own check
# (src/check-run.js POST /repos/{owner}/{repo}/check-runs).
permissions:
  contents: read
  pull-requests: read
  # checks: write

jobs:
  contract-gate-action:
    name: contract-gate (Action)
    runs-on: ubuntu-latest
    outputs:
      receipt-id: ${{ steps.gate.outputs.receipt-id }}
      conclusion: ${{ steps.gate.outputs.conclusion }}
      reason: ${{ steps.gate.outputs.reason }}
      title: ${{ steps.gate.outputs.title }}
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          # REQUIRED: the gate derives the change set from `git diff base...head`, so the full
          # history (both sides of the diff) must be present locally.
          fetch-depth: 0

      - id: gate
        uses: coderifts/contract-gate@v0
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
          RECEIPT_ID: ${{ needs.contract-gate-action.outputs.receipt-id }}
          CONCLUSION: ${{ needs.contract-gate-action.outputs.conclusion }}
          REASON: ${{ needs.contract-gate-action.outputs.reason }}
          TITLE: ${{ needs.contract-gate-action.outputs.title }}
        run: |
          echo "contract-gate-action result: $GATE_RESULT"
          echo "receipt-id: $RECEIPT_ID"
          echo "conclusion: $CONCLUSION"
          echo "reason: $REASON"
          echo "title: $TITLE"
          # success | failure | cancelled | skipped — only the first is a pass.
          # A job check-run's output cannot be set from this step. These lines are the log.
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

- A head commit that carries a `CodeRifts-Receipt` trailer and a `.coderifts/receipts/<sha>.json` sidecar is verified offline against the pinned keyring. That run does not call preflight. On this profile the envelope must also match this run: `preflight_mode` `authorize`, `repository` `<owner>/<repo>`, `base` the run's base SHA, `head` the run's head SHA. The comparison is `mismatchReason` (`src/gate.js`). A missing or different slot is `mode_mismatch`, `repo_mismatch`, `base_mismatch`, or `head_mismatch`. A trailer or sidecar skips a slot only when that slot is unbound. An issued receipt does not.
- With no trailer and no sidecar, and with `require-receipt-trailer` left false, the gate issues a receipt, verifies that receipt offline, and writes it to the step summary. The receipt is never written onto the commit. The issued envelope is held to the same four slots, and a missing slot fails closed.
- On `merge_group` the run's SHAs are `merge_group.base_sha` and `merge_group.head_sha` (`readEvent` in `src/index.js`). A trailer minted for the pull-request head names the pull-request SHAs. `base_mismatch` or `head_mismatch` on that event, with `require-receipt-trailer` left false, is not a verdict about the queued commit: the run logs the reason and issues a receipt for the merge-group SHAs. `repo_mismatch` and `mode_mismatch` stay failures. With `require-receipt-trailer: true`, a mismatch stays a failure.

> **CWM honesty.** With `require_verified_monitoring: true` the gate verifies a `cr.monitor.attest.v1` token offline against a pinned monitoring keyring (CWM passes only on `delivered_acked`); by default it passes CWM on the host's claim. The token proves a monitoring-key holder observed the delivery — not that a human read it, not that the sink targets the right audience. Unsigned JSON is not accepted under the flag.

## Requiring the receipt on the head commit (`require-receipt-trailer`)

Default `false`. On the enforcing profile a missing trailer then falls through to issuance when `api-key` is set. With no key, that run fails `receipt_trailer_missing` and does not call preflight.

With `require-receipt-trailer: 'true'`, no verifying trailer or sidecar fails before any preflight call, on every profile, with reason `receipt_trailer_required`. A trailer that is present is still checked offline:

- **Carrier.** A `CodeRifts-Receipt: <token>` trailer in the head commit message, and/or a
  `.coderifts/receipts/<head-sha>.json` sidecar `{ "receipt": "<token>", "envelope": { … } }` in the
  workspace. Both present and different → failure (neither is used).
- **Authentic.** The token verifies against the **pinned keyring** with the vendored verifier.
- **This diff.** The signed envelope's `artifact_digest` must equal the digest the gate computes from
  the pull request's actual contract diff (sha256 over each artifact's before/after bytes, sorted by
  type and id — the recipe the CodeRifts API signs).
- **An ALLOW.** The envelope's `execution_action` must be `CONTINUE`. On the enforcing profile it must also be `operation: merge`, and the four run slots above must match.

The envelope is required: a trailer carries only the token, which proves the receipt is authentic
but not which diff it covers, so **a trailer on its own fails** (`receipt_envelope_required`). A
sidecar keyed by the head SHA cannot live inside the head commit (the SHA would change) — write it
into the workspace in a step before the gate.

Conflicting, unauthentic, a different diff, not an ALLOW, or a run-slot mismatch → the check fails, with the reason (`receipt_trailer_conflict`, `receipt_trailer_invalid`, `receipt_diff_mismatch`, `receipt_not_allow`, `receipt_envelope_required`, `mode_mismatch`, `repo_mismatch`, `base_mismatch`, `head_mismatch`) in the summary. A missing carrier when the flag is true is `receipt_trailer_required`. When the flag is false and the profile is enforcing, a missing carrier is not that reason: it falls through, or it is `receipt_trailer_missing` when there is no key.

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

One job. The Action posts `CodeRifts / contract-gate` itself, because `post-check-run` is left at its default `true`. That is not the suggested setup. The suggested setup is the aggregator job above, with `post-check-run: 'false'`, and branch protection requiring both contexts. This job posts the check, so it keeps `checks: write`. The suggested setup does not.

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

## Where it stops

A fork pull request does not receive `CODERIFTS_API_KEY`. GitHub does not pass secrets to a workflow triggered from a fork. This action then has no key, issues nothing, and fails closed with `receipt_trailer_missing`, unless the head already carries a verifying trailer or sidecar. That offline path does not call the issuer.

The required context `CodeRifts / contract-gate` is posted by the workflow's `GITHUB_TOKEN`, so it carries the Actions identity (`src/gate.js`). Anyone who can edit `.github/workflows/` can change what that job runs and still post a green check under that name. That is why `CodeRifts / issuer`, posted by the App, is the second required check, and why it is bound to the App integration. Put CODEOWNERS on `.github/workflows/**`. Where the organisation has one, require the workflow at organisation level as well.

`pull_request_target` is not a trigger in `examples/contract-gate.yml`, and it is not recommended. A `pull_request_target` run has the base repository's secrets and checks out the fork's code (pwn-request).

Until 0.11.7 this action concluded success on a control-plane-only change, and the merge was held by the App check alone. On 2026-10-11, coderifts/demo PR #33 changed only `.github/workflows/contract-gate.yml` (head `2ca2aca2ccbb73c13c07f1bf10ac25de9f4d31ca`, a comment). Reader check-run 114510055851 (`CodeRifts / contract-gate`, v0.11.6) succeeded: the diff had no contract artifact, so the action returned `no_contract_changes` and never read the issued receipt. The issuer failed with `REQUEST_APPROVAL · CONTROL_PLANE_CHANGE`: check-run 114510017575 completed 2026-10-11T15:50:35Z with summary "have 0"; after review 5483938946 and `/rerun` comment 6110898348, check-run 114512261388 completed 2026-10-11T16:01:42Z with summary "have 1". From 0.11.8 that diff takes the receipt path. The path list is `src/control-plane.js`, the same list as coderifts-app `src/mergegate/control-plane.js`, quoted from DECISIONS.md, "A control-plane change is never neutral (2026-10-11)".

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
