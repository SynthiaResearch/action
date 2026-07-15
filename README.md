# Synthia Agent Evals — GitHub Action

Run [Synthia](https://try-synthia.vercel.app) agent evals on every pull
request: your agent plays a pinned suite of simulated-user scenarios, a judge
scores each rollout, and the PR gets a pass/fail check plus a comment with
score deltas against your main branch and a link to the full hosted report.

The action is a **bundled** JavaScript action: the Synthia CLI is compiled
into `dist/index.js` at release time, so your CI job makes **no registry
fetches** — the code that runs is exactly the code at the ref you pin.

## Quickstart

1. Add `SYNTHIA_API_KEY` to your repository's Actions secrets (plus whatever
   keys your agent itself needs, e.g. `ANTHROPIC_API_KEY`).
2. Commit a `synthia.yaml` (see the [full reference](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/configuration.md)):

```yaml
version: 1
agent:
  entrypoint: ./src/agent.ts   # exports a RolloutAgent: (transcript, sandbox) => reply
run:
  dataset: ds_your_dataset_id  # pin a dataset for reproducible CI runs
thresholds:
  pass_rate: 0.8
baseline:
  branch: main                 # deltas vs the newest run on this branch
```

3. Commit the workflow:

```yaml
name: synthia
on:
  pull_request:            # never pull_request_target — see Security
  push:
    branches: [main]       # runs on main seed the baseline for PR deltas

permissions:
  contents: read
  pull-requests: write     # only for the PR comment; drop if comment: false

jobs:
  evals:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npm ci
      - uses: SynthiaResearch/synthia-action@v1
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}  # your agent's own keys
        with:
          api-key: ${{ secrets.SYNTHIA_API_KEY }}
```

Pin by SHA if your organization requires it (Dependabot/Renovate keep the
comment fresh):

```yaml
      - uses: SynthiaResearch/synthia-action@<commit-sha>  # v1
```

## Inputs

| Input | Default | Purpose |
|---|---|---|
| `api-key` | — (required) | Synthia API key, from Actions secrets |
| `config` | `synthia.yaml` | Config path, relative to `working-directory` |
| `fail-on-threshold` | — | Override `thresholds.pass_rate` for this run |
| `working-directory` | `.` | Directory containing the config and agent |
| `comment` | `true` | Post/update the PR comment on `pull_request` events |
| `github-token` | `${{ github.token }}` | Token for the PR comment |
| `language` | `node` | Agent runtime: `node` (in-process JS/TS) or `python` |
| `results-path` | `synthia-results.json` | Where the python CLI writes / the action reads results (python only) |
| `warn-only` | `false` | Advisory mode: post the comment but keep the check green (don't block the PR on a failed gate) |

### Adopting non-blocking first

Set `warn-only: true` to run Synthia in advisory mode — every PR still gets the
full comment with scores, baseline deltas, and named regressions, but the check
stays green so it never blocks a merge (config/infra errors still fail). Once
your suite and thresholds are calibrated, drop `warn-only` and, if you want it
enforced, mark the check required in branch protection. The bare CLI has the
same `--warn-only` flag.

Outputs: `status` (`passed`/`failed`), `pass-rate`, `report-url`.

### Python agents

Set `language: python` and install the CLI from PyPI in a prior step
(`pip install synthiaresearch`, analogous to `npm ci` for the node path). The
action shells out to `python -m synthia run`, reads the results JSON it writes,
and posts the identical PR comment. Your `agent.entrypoint` then points at a
Python module exporting `agent(transcript, sandbox) -> reply`. See
[docs/ci.md](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/ci.md)
for the full Python workflow.

## How it works

Your agent runs **in this job, in process** — the action loads the
`agent.entrypoint` module and drives it against scenarios served by Synthia's
API. Only agent replies and tool-call events leave the runner (scrubbed by
default: secret-shaped strings are redacted before upload — see
`telemetry.redact` in the schema). Results land in `synthia-results.json`
(scores and metadata only, never transcripts) and the hosted report.

Exit behavior: the check fails when the suite pass rate misses
`thresholds.pass_rate`, when fewer than `thresholds.min_scenarios` rollouts
were evaluated, or when the drop vs baseline exceeds `baseline.max_regression`
(when set).

## Security

- Use `on: pull_request`. **Never `pull_request_target`** with a checkout of
  the PR head — that hands your secrets to unreviewed fork code. Fork PRs
  don't receive secrets, so this action skips gracefully there.
- Set the explicit least-privilege `permissions` block shown above and
  `persist-credentials: false` on checkout.
- Egress allowlist (e.g. StepSecurity harden-runner `allowed-endpoints`):

```
synthia-research--synthia-api-web.modal.run:443
```

  plus whatever hosts your agent itself calls (e.g. `api.anthropic.com:443`).
- The env vars read by the bundled CLI: `SYNTHIA_API_KEY` (set from the
  `api-key` input), `SYNTHIA_BASE_URL`, and the standard non-secret
  `GITHUB_*` context. It never enumerates `process.env`.

Full inventory of what the action reads, sends, and requires: [SECURITY.md](./SECURITY.md).
