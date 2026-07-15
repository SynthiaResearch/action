/**
 * The Synthia GitHub Action: a thin wrapper that runs a `synthia run` eval and
 * turns the report into a PR comment, job summary, and check verdict.
 *
 * Two drivers, one tail: `language: node` runs the bundled JS CLI in-process
 * (no npm install, no registry fetch); `language: python` shells out to
 * `python -m synthia` (which the customer installed from PyPI) and reads back
 * the results JSON it writes. Both yield a `{report, exitCode}` that flows
 * through the identical comment/summary/output/gate path below.
 *
 * Egress: api host only (see README's harden-runner snippet).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as core from "@actions/core";
import * as github from "@actions/github";

import { runCommand, type RunOutcome, type RunReport } from "synthiaresearch/ci";
import { commentMarker, renderComment } from "./comment.js";

async function main(): Promise<void> {
  const apiKey = core.getInput("api-key");
  if (!apiKey) {
    // Fork PRs never receive secrets — skip green instead of failing, so the
    // recommended workflow needs no secret-presence gate step.
    const msg =
      "no api-key available (fork PR, or the SYNTHIA_API_KEY secret is not " +
      "configured) — skipping Synthia evals";
    core.notice(msg);
    await core.summary
      .addRaw(`### Synthia evals skipped\n\n${msg}\n`)
      .write();
    core.setOutput("status", "skipped");
    return;
  }
  core.setSecret(apiKey);
  process.env["SYNTHIA_API_KEY"] = apiKey;

  const workingDirectory = core.getInput("working-directory");
  if (workingDirectory && workingDirectory !== ".") {
    process.chdir(workingDirectory);
  }

  const config = core.getInput("config") || "synthia.yaml";
  const thresholdInput = core.getInput("fail-on-threshold");
  const failOnThreshold = thresholdInput ? Number(thresholdInput) : undefined;
  const language = core.getInput("language") || "node";
  const warnOnly = core.getBooleanInput("warn-only");
  const sessionSuffix = core.getInput("session-suffix") || undefined;

  let outcome: RunOutcome;
  try {
    outcome =
      language === "python"
        ? await runPython(config, failOnThreshold, warnOnly, sessionSuffix,
            core.getInput("results-path") || "synthia-results.json")
        : await runCommand({ config, failOnThreshold, warnOnly, sessionSuffix });
  } catch (e) {
    // ConfigError/InfraError (node) or subprocess-with-no-results (python) —
    // setup problems, no report to comment with.
    core.setFailed(e instanceof Error ? e.message : String(e));
    return;
  }

  const { report } = outcome;
  if (report) {
    core.setOutput("status", report.status);
    core.setOutput("pass-rate", report.totals.pass_rate);
    core.setOutput("report-url", report.report_url);

    const body = renderComment(report, warnOnly, sessionSuffix);
    await core.summary.addRaw(body).write();
    if (
      core.getBooleanInput("comment") &&
      github.context.eventName === "pull_request"
    ) {
      await upsertComment(body, commentMarker(sessionSuffix));
    }

    // Advisory mode keeps the check green, which makes a failed gate invisible
    // in the checks UI — surface it as a yellow annotation instead.
    if (warnOnly && report.status === "failed") {
      core.warning(
        `Synthia gate failed (pass rate ` +
          `${(report.totals.pass_rate * 100).toFixed(1)}%) — advisory ` +
          `(warn-only), not blocking: ${report.report_url}`,
      );
    }
  }

  if (outcome.exitCode !== 0) {
    core.setFailed(
      report
        ? `pass rate ${(report.totals.pass_rate * 100).toFixed(1)}% did not ` +
            `meet the gates — see the summary or ${report.report_url}`
        : "synthia run failed",
    );
  }
}

/**
 * Drive the Python CLI: `python -m synthia run` (invoked as a module, not the
 * bare `synthia` bin, to avoid colliding with the npm CLI of the same name),
 * streaming its output live, then read the results JSON it wrote. Throws when
 * no readable results exist (config/infra exit, or a malformed file), so the
 * caller's catch turns it into setFailed-with-no-comment.
 */
async function runPython(
  config: string,
  failOnThreshold: number | undefined,
  warnOnly: boolean,
  sessionSuffix: string | undefined,
  resultsPath: string,
): Promise<RunOutcome> {
  const args = ["-m", "synthia", "run", "--config", config,
    "--output", resultsPath,
    ...(failOnThreshold != null
      ? ["--fail-on-threshold", String(failOnThreshold)]
      : []),
    ...(warnOnly ? ["--warn-only"] : []),
    ...(sessionSuffix ? ["--session-suffix", sessionSuffix] : [])];

  const { code, stderrTail } = await new Promise<{
    code: number | null;
    stderrTail: string;
  }>((res, rej) => {
    // stdout inherits (streams live to the action log); stderr is teed so it
    // shows live AND is captured (capped) for the failure message.
    const child = spawn("python", args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "inherit", "pipe"],
    });
    let tail = "";
    child.stderr.on("data", (d: Buffer) => {
      process.stderr.write(d);
      tail = (tail + d.toString()).slice(-8192);
    });
    child.on("error", (e) =>
      rej(new Error(
        `could not launch the synthia Python CLI (${e.message}) — did a ` +
          "prior step run `pip install synthiaresearch`?")));
    child.on("close", (c) => res({ code: c, stderrTail: tail }));
  });

  let report: RunReport;
  try {
    const parsed = JSON.parse(readFileSync(resolve(resultsPath), "utf8"));
    if (!isRunReport(parsed)) throw new Error("unexpected results shape");
    report = parsed;
  } catch (readErr) {
    throw new Error(
      `synthia run exited ${code ?? "?"} without readable results at ` +
        `${resultsPath}: ${stderrTail.trim() ||
          (readErr instanceof Error ? readErr.message : String(readErr))}`);
  }
  // exit 0 → passed, 1 → gate failed (report present either way); 2/3 wrote no
  // JSON and were already thrown above.
  return { report, exitCode: (code ?? 3) as 0 | 1 | 2 | 3 };
}

/** Minimal runtime guard so a JS/Python results-shape mismatch surfaces as a
 * clear failure, not a stack trace inside renderComment. */
function isRunReport(v: unknown): v is RunReport {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    (r["status"] === "passed" || r["status"] === "failed") &&
    typeof r["totals"] === "object" && r["totals"] !== null &&
    typeof r["thresholds"] === "object" && r["thresholds"] !== null &&
    Array.isArray(r["scenarios"]) &&
    typeof r["config"] === "object" && r["config"] !== null &&
    typeof r["report_url"] === "string"
  );
}

/** Update the existing Synthia comment (found by marker) or create one. */
async function upsertComment(body: string, marker: string): Promise<void> {
  const token = core.getInput("github-token");
  if (!token) {
    core.warning("no github-token available — skipping PR comment");
    return;
  }
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const issue_number = github.context.payload.pull_request?.number;
  if (!issue_number) return;

  try {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number,
      per_page: 100,
    });
    const existing = comments.find((c) => c.body?.includes(marker));
    if (existing) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      });
    } else {
      await octokit.rest.issues.createComment({ owner, repo, issue_number, body });
    }
  } catch (e) {
    // Comment posting is reporting, not gating — never fail the check on it
    // (common cause: workflow lacks `pull-requests: write`).
    core.warning(
      `could not post PR comment: ${e instanceof Error ? e.message : e} — ` +
        "does the workflow grant `permissions: pull-requests: write`?",
    );
  }
}

main().catch((e) => core.setFailed(e instanceof Error ? e.message : String(e)));
