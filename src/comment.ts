import type { RunReport } from "synthiaresearch/ci";

/** Hidden marker so re-runs update one comment instead of stacking new ones.
 * Scoped by session-suffix: each suite in a multi-agent repo owns its own
 * comment — otherwise the last suite to finish overwrites the others'. */
export const commentMarker = (sessionSuffix?: string) =>
  sessionSuffix
    ? `<!-- synthia-ci-report:${sessionSuffix} -->`
    : "<!-- synthia-ci-report -->";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pp = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pp`;

/**
 * The PR comment: verdict, score + baseline delta, weakest scenarios,
 * config drift vs the baseline run, warnings, and the hosted report link.
 * Everything here comes from the results report — never transcripts.
 */
export function renderComment(
  report: RunReport,
  advisory = false,
  sessionSuffix?: string,
): string {
  const lines: string[] = [commentMarker(sessionSuffix)];
  const icon = report.status === "passed" ? "✅" : "❌";
  const b = report.baseline;

  const suite = sessionSuffix ? ` (${sessionSuffix})` : "";
  lines.push(`## ${icon} Synthia evals${suite}: ${report.status}`);
  if (advisory && report.status !== "passed") {
    lines.push("");
    lines.push("_Advisory (warn-only): reported but not blocking this PR._");
  }
  lines.push("");
  const delta = b ? ` (${b.branch}: ${pct(b.pass_rate)}, Δ ${pp(b.delta)})` : "";
  lines.push(
    `**${pct(report.totals.pass_rate)} pass rate** — ` +
      `${report.totals.passed}/${report.totals.evaluated} rollouts across ` +
      `${report.totals.scenarios} scenarios${delta} · ` +
      `threshold ${pct(report.thresholds.pass_rate)} ` +
      `${report.thresholds.passed ? "met" : "**not met**"}`,
  );
  if (b && b.max_regression !== null) {
    lines.push(
      `Regression gate (max ${pct(b.max_regression)}): ` +
        `${b.gate_passed ? "met" : "**not met**"}`,
    );
  }
  if (!b) {
    lines.push(
      `_No baseline for \`${report.config.effective ? ((report.config.effective["baseline"] as any)?.branch ?? "main") : "main"}\` yet — deltas appear once a run on that branch exists._`,
    );
  }

  const failing = report.scenarios.filter((s) => s.pass_rate < 1);
  if (failing.length) {
    lines.push("");
    lines.push("| | Scenario | Family | Passed | Judge's finding |");
    lines.push("|---|---|---|---|---|");
    for (const s of failing.slice(0, 8)) {
      const name = s.title ?? s.scenario_id;
      lines.push(
        `| ${s.passed === 0 ? "❌" : "⚠️"} | ${escapeCell(name)} | ` +
          `${s.task_family ?? "—"} | ${s.passed}/${s.repeats} | ` +
          `${s.top_issue ? escapeCell(s.top_issue) : "—"} |`,
      );
    }
  }

  const drift = configDrift(report);
  if (drift.length) {
    lines.push("");
    lines.push("**Config changed vs baseline run:**");
    for (const d of drift) lines.push(`- ${d}`);
  }
  for (const w of report.config.warnings) {
    lines.push(`> ⚠️ ${w}`);
  }

  lines.push("");
  lines.push(`[Full report →](${report.report_url})`);
  return lines.join("\n");
}

/** Dotted-path diff of this run's effective config vs the baseline run's —
 * makes a PR that weakens its own thresholds visible where reviewers look. */
export function configDrift(report: RunReport): string[] {
  const baseline = report.baseline?.effective_config;
  if (!baseline) return [];
  const drift: string[] = [];
  walk(baseline, report.config.effective, "", drift);
  return drift;
}

function walk(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix: string,
  out: string[],
): void {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const path = prefix ? `${prefix}.${key}` : key;
    const b = before[key];
    const a = after[key];
    if (isRecord(b) && isRecord(a)) {
      walk(b, a, path, out);
    } else if (JSON.stringify(b) !== JSON.stringify(a)) {
      out.push(`\`${path}\`: ${fmt(b)} → ${fmt(a)}`);
    }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const fmt = (v: unknown) => (v === undefined ? "unset" : JSON.stringify(v));
const escapeCell = (s: string) => s.replace(/\|/g, "\\|");
