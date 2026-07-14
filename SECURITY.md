# Security policy — Synthia Agent Evals action

CI actions receive repository context and secrets, so this action is built to
be auditable and minimal. This document inventories exactly what it does.

## Reporting a vulnerability

Email **security@synthia.dev** with details and a reproduction. We aim to
acknowledge within 2 business days. Please do not open a public issue for
undisclosed vulnerabilities.

## What runs

The action is a **bundled** JavaScript action: the Synthia CLI is compiled
into `dist/index.js` at release time. Your CI job makes **no package-registry
fetches** — the code that runs is exactly the code at the git ref you pin.
Audit `dist/index.js` (or the source in the Synthia monorepo,
`packages/action` + `packages/sdk-js/src/cli`) before pinning.

## Environment variables read

The action and the bundled CLI read exactly these, and never enumerate
`process.env`:

| Variable | Purpose |
|---|---|
| `SYNTHIA_API_KEY` | Your Synthia key (from the `api-key` input). Masked via `core.setSecret` before any other work. |
| `SYNTHIA_BASE_URL` | Optional API host override. |
| `GITHUB_ACTIONS`, `GITHUB_REPOSITORY`, `GITHUB_SHA`, `GITHUB_REF_NAME`, `GITHUB_HEAD_REF`, `GITHUB_EVENT_NAME`, `GITHUB_RUN_ID`, `GITHUB_SERVER_URL` | Non-secret CI provenance recorded on the run (commit, branch, PR number). |

Your agent's own keys (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) are read by
your agent code, not by this action.

**`language: python`**: the action shells out to `python -m synthia` and passes
its full environment to the subprocess (necessary so your agent sees its own
keys). This is equivalent to the `node` path, where the in-process agent
already runs with full `process.env`. The Python CLI applies the same env
policy — it reads only `SYNTHIA_API_KEY`, `SYNTHIA_BASE_URL`, and the named
`GITHUB_*` context vars, and never enumerates the environment.

## Network egress

Outbound only. For a hardened runner (e.g. StepSecurity harden-runner
`allowed-endpoints`) allow:

```
synthia-research--synthia-api-web.modal.run:443
```

plus whatever hosts your own agent calls. The action opens no inbound ports
and starts no server.

## Permissions

The workflow needs only:

```yaml
permissions:
  contents: read
  pull-requests: write   # solely to post/update the PR comment; drop with comment: false
```

## Data handling

- Agent replies and tool-call events are uploaded to the Synthia API to run
  the evaluation. **Secret-shaped strings are redacted before upload** by
  default (`sk-`, `ghp_`, `github_pat_`, AWS keys, JWTs, Slack tokens, Synthia
  key prefixes); extend via `telemetry.redact.patterns` in `synthia.yaml`.
- The results JSON written to the workspace contains **scores and metadata
  only** — never transcripts, tool payloads, or credentials — so it is safe to
  upload as a build artifact.
- The API key and any session token are never written to logs (including
  `--verbose`), the results file, or the PR comment.

## Supply-chain hygiene for consumers

- Pin to `@v1` for auto-updated fixes, or to a full commit SHA if your org
  requires it (Dependabot/Renovate keep SHA pins fresh).
- Use `on: pull_request` only — **never `pull_request_target`** with a checkout
  of the PR head. Fork PRs receive no secrets and the action skips gracefully.
- Set `persist-credentials: false` on `actions/checkout`.
