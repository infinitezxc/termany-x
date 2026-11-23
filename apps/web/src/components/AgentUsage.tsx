import { useEffect, useMemo, useState } from "react";
import { useAgentConfigs } from "../agents";
import { apiPath } from "../api";
import { UsageSelect } from "./Select";
import { UsageRangePicker, type RangeChoice } from "./UsageRangePicker";
import { useI18n } from "../i18n";
import { ChartIcon } from "./icons";
import { tildify } from "../tildify";

interface UsageRow {
  agent: string;
  project: string | null; // session cwd
  date: string; // local YYYY-MM-DD
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Part of cacheWrite on the 1-hour TTL. */
  cacheWrite1h?: number;
}

/**
 * Best-effort $/MTok price list for cost estimation (first-party Standard
 * short-context rates). Substring-matched in order against the model id recorded
 * in transcripts, allowing provider prefixes such as `eu.anthropic.`. A more
 * specific id must come before its family prefix.
 * Unmatched models still count toward token totals but are excluded from the
 * cost card (with a note). Cache writes are derived from the input price:
 * 1.25x for the 5-minute TTL, 2x for the 1-hour TTL Claude Code uses. Cache
 * reads vary by model, so they are listed.
 */
const PRICING: Array<{ prefix: string; input: number; output: number; cacheRead: number }> = [
  { prefix: "claude-fable-5-1", input: 10, output: 50, cacheRead: 0.25 },
  { prefix: "claude-mythos-5-1", input: 10, output: 50, cacheRead: 0.25 },
  { prefix: "claude-fable-5", input: 10, output: 50, cacheRead: 1 },
  { prefix: "claude-mythos-5", input: 10, output: 50, cacheRead: 1 },
  { prefix: "claude-opus-5-5", input: 4, output: 20, cacheRead: 0.2 },
  { prefix: "claude-opus-5", input: 5, output: 25, cacheRead: 0.5 },
  // Opus 4 / 4.1 (claude-opus-4-20250514, claude-opus-4-1-…) kept the old price.
  { prefix: "claude-opus-4-0", input: 15, output: 75, cacheRead: 1.5 },
  { prefix: "claude-opus-4-1", input: 15, output: 75, cacheRead: 1.5 },
  { prefix: "claude-opus-4-2", input: 15, output: 75, cacheRead: 1.5 },
  { prefix: "claude-opus-4", input: 5, output: 25, cacheRead: 0.5 },
  { prefix: "claude-sonnet-5", input: 2, output: 10, cacheRead: 0.2 },
  { prefix: "claude-sonnet-4", input: 3, output: 15, cacheRead: 0.3 },
  { prefix: "claude-3-7-sonnet", input: 3, output: 15, cacheRead: 0.3 },
  { prefix: "claude-3-5-sonnet", input: 3, output: 15, cacheRead: 0.3 },
  { prefix: "claude-haiku-4-5", input: 1, output: 5, cacheRead: 0.1 },
  { prefix: "claude-3-5-haiku", input: 0.8, output: 4, cacheRead: 0.08 },
  { prefix: "claude-3-haiku", input: 0.25, output: 1.25, cacheRead: 0.03 },
  // OpenAI GPT-6.2 rates: https://developers.openai.com/api/docs/pricing
  { prefix: "gpt-6.2-astra", input: 8, output: 40, cacheRead: 0.4 },
  { prefix: "gpt-6.2-sol", input: 2, output: 10, cacheRead: 0.1 },
  // Older OpenAI rates: https://platform.openai.com/pricing (verified 2026-10-17).
  { prefix: "gpt-6.1-sol", input: 2, output: 10, cacheRead: 0.1 },
  { prefix: "gpt-6-astra", input: 10, output: 50, cacheRead: 1 },
  { prefix: "gpt-6-sol", input: 2, output: 10, cacheRead: 0.2 },
  { prefix: "gpt-6-luna", input: 0.1, output: 0.5, cacheRead: 0.01 },
  { prefix: "gpt-5-mini", input: 0.25, output: 2, cacheRead: 0.025 },
  { prefix: "gpt-5-nano", input: 0.05, output: 0.4, cacheRead: 0.005 },
  { prefix: "gpt-5", input: 1.25, output: 10, cacheRead: 0.125 },
  { prefix: "o3", input: 2, output: 8, cacheRead: 0.5 },
];

function priceFor(model: string) {
  return PRICING.find((p) => model.includes(p.prefix)) ?? null;
}

function rowCost(r: UsageRow): number | null {
  const p = priceFor(r.model);
  if (!p) return null;
  // Older servers don't report the 1-hour split; treat their writes as 5-minute.
  const write1h = Math.min(r.cacheWrite, r.cacheWrite1h ?? 0);
  return (
    (r.input * p.input +
      r.output * p.output +
      r.cacheRead * p.cacheRead +
      (r.cacheWrite - write1h) * p.input * 1.25 +
      write1h * p.input * 2) /
    1e6
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}

function formatCost(n: number): string {
  return `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;
}

function localDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}


const RANGES = [
  { key: "today", labelKey: "usage.range.today" },
  { key: "week", labelKey: "usage.range.week" },
  { key: "month", labelKey: "usage.range.month" },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];

/** Matches the server's USAGE_MAX_DAYS: the oldest day it will report. */
const MAX_LOOKBACK_DAYS = 366;

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDateString(d);
}

function rangeCutoff(range: RangeKey): string {
  const d = new Date();
  if (range === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
  else if (range === "month") d.setDate(1);
  return localDateString(d);
}

/** Inclusive [since, until]; presets are recomputed so "today" stays current. */
function rangeBounds(choice: RangeChoice<RangeKey>): { since: string; until: string } {
  if (choice.preset !== null) return { since: rangeCutoff(choice.preset), until: localDateString(new Date()) };
  const oldest = daysAgo(MAX_LOOKBACK_DAYS - 1);
  return { since: choice.since < oldest ? oldest : choice.since, until: choice.until };
}

function dayStart(date: string): Date {
  return new Date(`${date}T00:00:00`);
}

/** Bars beyond this are grouped into multi-day buckets so they stay legible. */
const MAX_CHART_BARS = 31;

/**
 * Agent token-usage dashboard (the SideRail chart button): totals + estimated
 * cost cards, a daily input/output bar chart, and a per-model breakdown, all
 * computed client-side from range-bounded /api/agent-usage rows. Cache tokens
 * are shown in the cards and cost but excluded from the chart — they'd dwarf
 * everything else. Opened from an SSH pane, it shows that host's usage — its
 * agents run there (same as AgentHistory).
 */
/** `ssh` is the host to report on (see usePaneHost); undefined for this machine. */
export function AgentUsage({ ssh }: { ssh?: { label: string; session: string } }) {
  const { t, language } = useI18n();
  const agentConfigs = useAgentConfigs();
  const [rows, setRows] = useState<UsageRow[] | null | undefined>(undefined);
  const [stale, setStale] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [range, setRange] = useState<RangeChoice<RangeKey>>({ preset: "today" });
  const { since, until } = rangeBounds(range);
  const [agent, setAgent] = useState("all");
  const [project, setProject] = useState("all");

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    setRows(undefined);
    setErrorDetail(null);
    // Older servers ignore `until`; the client-side filter below enforces it anyway.
    const params = new URLSearchParams({ since, until });
    if (ssh) params.set("session", ssh.session);
    fetch(apiPath(`/api/agent-usage?${params}`), { signal: abort.signal })
      .then(async (r) => {
        if (r.ok) return r.json();
        // The server answers failures with { error }; keep it so the cause is visible.
        const body = await r.json().catch(() => null);
        const err = new Error(String(r.status)) as Error & { detail?: string };
        if (typeof body?.error === "string") err.detail = body.error;
        throw err;
      })
      .then((data) => {
        if (!cancelled) setRows(Array.isArray(data.rows) ? data.rows : []);
      })
      .catch((e: Error & { detail?: string }) => {
        if (cancelled || e.name === "AbortError") return;
        // A 404 on a route this build ships means the backend answering us is
        // older than the UI — an upgrade left the previous release's server
        // holding the port. Say so instead of blaming the data.
        setStale(e.message === "404");
        setErrorDetail(e.detail ?? (e.message === "404" ? null : e.message));
        setRows(null);
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [since, until, ssh]);

  const agentIds = useMemo(
    () => [...new Set((rows ?? []).map((r) => r.agent))].sort(),
    [rows]
  );

  const agentName = (id: string) => agentConfigs.find((a) => a.id === id)?.name ?? id;
  const projectName = (r: UsageRow) => (r.project ? tildify(r.project) : "(unknown)");

  // Busiest-first so the projects you care about sit at the top of the
  // dropdown; scoped to the selected agent so the list stays relevant.
  const projectOptions = useMemo(() => {
    const totals = new Map<string, number>();
    for (const r of rows ?? []) {
      if (agent !== "all" && r.agent !== agent) continue;
      const name = projectName(r);
      totals.set(name, (totals.get(name) ?? 0) + r.input + r.output + r.cacheRead + r.cacheWrite);
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  }, [rows, agent]);

  useEffect(() => {
    if (project !== "all" && !projectOptions.includes(project)) setProject("all");
  }, [projectOptions, project]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter(
      (r) =>
        (agent === "all" || r.agent === agent) &&
        (project === "all" || projectName(r) === project) &&
        r.date >= since &&
        r.date <= until
    );
  }, [rows, since, until, agent, project]);

  const totals = useMemo(() => {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    let unpricedTokens = 0;
    for (const r of filtered) {
      input += r.input;
      output += r.output;
      cacheRead += r.cacheRead;
      cacheWrite += r.cacheWrite;
      const c = rowCost(r);
      if (c === null) unpricedTokens += r.input + r.output + r.cacheRead + r.cacheWrite;
      else cost += c;
    }
    return { input, output, cacheRead, cacheWrite, cost, unpricedTokens };
  }, [filtered]);

  // Continuous day series (missing days rendered as empty slots) so the chart
  // reads as a calendar, not just a list of active days. It spans exactly the
  // selected range; long custom ranges group consecutive days into one bar.
  const { days, bucketDays } = useMemo(() => {
    const byDate = new Map<string, { input: number; output: number }>();
    for (const r of filtered) {
      const d = byDate.get(r.date) ?? { input: 0, output: 0 };
      d.input += r.input;
      d.output += r.output;
      byDate.set(r.date, d);
    }
    // Step by calendar date (not 24h) so DST shifts can't skip or repeat a day.
    const all: string[] = [];
    for (const d = dayStart(since); localDateString(d) <= until; d.setDate(d.getDate() + 1)) {
      all.push(localDateString(d));
    }
    const size = Math.max(1, Math.ceil(all.length / MAX_CHART_BARS));
    const out: Array<{ date: string; end: string; input: number; output: number }> = [];
    for (let i = 0; i < all.length; i += size) {
      const slice = all.slice(i, i + size);
      let input = 0;
      let output = 0;
      for (const date of slice) {
        const v = byDate.get(date);
        input += v?.input ?? 0;
        output += v?.output ?? 0;
      }
      out.push({ date: slice[0], end: slice[slice.length - 1], input, output });
    }
    return { days: out, bucketDays: size };
  }, [filtered, since, until]);
  // Year-crossing ranges need the year on the axis; same-year ranges read cleaner without it.
  const axisLabel = (date: string) => (since.slice(0, 4) === until.slice(0, 4) ? date.slice(5) : date);

  const chartMax = Math.max(1, ...days.map((d) => d.input + d.output));

  const models = useMemo(() => {
    const byModel = new Map<string, { model: string; tokens: number; cost: number | null }>();
    for (const r of filtered) {
      const m = byModel.get(r.model) ?? { model: r.model, tokens: 0, cost: 0 };
      m.tokens += r.input + r.output + r.cacheRead + r.cacheWrite;
      const c = rowCost(r);
      m.cost = c === null || m.cost === null ? null : m.cost + c;
      byModel.set(r.model, m);
    }
    return [...byModel.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 12);
  }, [filtered]);

  const modelMax = Math.max(1, ...models.map((m) => m.tokens));

  // A project mixes priced and unpriced models; sum what's priceable (same
  // convention as the Est. cost card) instead of nulling the whole project.
  const projects = useMemo(() => {
    const byProject = new Map<string, { project: string; tokens: number; cost: number }>();
    for (const r of filtered) {
      const name = r.project ? tildify(r.project) : t("usage.unknownProject");
      const p = byProject.get(name) ?? { project: name, tokens: 0, cost: 0 };
      p.tokens += r.input + r.output + r.cacheRead + r.cacheWrite;
      p.cost += rowCost(r) ?? 0;
      byProject.set(name, p);
    }
    return [...byProject.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 12);
  }, [filtered, t]);

  const projectMax = Math.max(1, ...projects.map((p) => p.tokens));
  const totalTokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;

  const cards = [
    {
      key: "cost",
      label: t("usage.card.cost"),
      value: formatCost(totals.cost),
      note:
        totals.unpricedTokens > 0
          ? t("usage.card.costNote", { n: formatTokens(totals.unpricedTokens) })
          : null,
    },
    { key: "total", label: t("usage.card.total"), value: formatTokens(totalTokens), note: null },
    { key: "input", label: t("usage.card.input"), value: formatTokens(totals.input), note: null },
    { key: "output", label: t("usage.card.output"), value: formatTokens(totals.output), note: null },
    {
      key: "cache",
      label: t("usage.card.cache"),
      value: formatTokens(totals.cacheRead + totals.cacheWrite),
      note: t("usage.card.cacheNote", {
        read: formatTokens(totals.cacheRead),
        write: formatTokens(totals.cacheWrite),
      }),
    },
  ];

  return (
    <div className="usage-pane">
        <div className="usage-header">
          <span className="usage-title">
            <ChartIcon />
            <span>{t("usage.title")}</span>
            {ssh && <span className="usage-host" title={ssh.label}>{ssh.label}</span>}
          </span>
          <div className="usage-filters">
            <UsageSelect
              width={132}
              value={agent}
              onChange={setAgent}
              options={[
                { value: "all", label: t("usage.allAgents") },
                ...agentIds.map((id) => ({ value: id, label: agentName(id) })),
              ]}
            />
            <UsageSelect
              width={210}
              value={project}
              onChange={setProject}
              options={[
                { value: "all", label: t("usage.allProjects") },
                ...projectOptions.map((name) => ({ value: name, label: name })),
              ]}
            />
            <UsageRangePicker
              preset={range.preset}
              since={since}
              until={until}
              presets={RANGES.map((r) => ({ key: r.key, label: t(r.labelKey) }))}
              min={daysAgo(MAX_LOOKBACK_DAYS - 1)}
              max={localDateString(new Date())}
              locale={language}
              hints={{
                start: t("usage.pickStart"),
                end: t("usage.pickEnd"),
                prevMonth: t("usage.prevMonth"),
                nextMonth: t("usage.nextMonth"),
              }}
              onChange={setRange}
            />
          </div>
        </div>

        {rows === undefined && <div className="search-empty">{t("usage.loading")}</div>}
        {rows === null && (
          <div className="search-empty usage-error">
            {t(stale ? "server.stale" : "usage.error")}
            {!stale && errorDetail && <div className="usage-error-detail">{errorDetail}</div>}
          </div>
        )}
        {Array.isArray(rows) && filtered.length === 0 && (
          <div className="search-empty">{t("usage.empty")}</div>
        )}

        {Array.isArray(rows) && filtered.length > 0 && (
          <div className="usage-body">
            <div className="usage-cards">
              {cards.map((c) => (
                <div key={c.key} className="usage-card">
                  <span className="usage-card-label">{c.label}</span>
                  <span className="usage-card-value">{c.value}</span>
                  {c.note && <span className="usage-card-note">{c.note}</span>}
                </div>
              ))}
            </div>

            <div className="usage-section">
              <div className="usage-section-head">
                <span>
                  {bucketDays > 1 ? t("usage.bucketed", { n: String(bucketDays) }) : t("usage.daily")}
                </span>
                <span className="usage-legend">
                  <i className="usage-swatch output" /> {t("usage.legend.output")}
                  <i className="usage-swatch input" /> {t("usage.legend.input")}
                  <span className="usage-legend-note">{t("usage.legend.note")}</span>
                </span>
              </div>
              <div className="usage-chart">
                {days.map((d) => (
                  <div
                    key={d.date}
                    className="usage-bar-slot"
                    title={`${d.date === d.end ? d.date : `${d.date} – ${d.end}`}\n${t("usage.chartTip", {
                      input: formatTokens(d.input),
                      output: formatTokens(d.output),
                    })}`}
                  >
                    <div className="usage-bar">
                      <div
                        className="usage-bar-output"
                        style={{ height: `${(d.output / chartMax) * 100}%` }}
                      />
                      <div
                        className="usage-bar-input"
                        style={{ height: `${(d.input / chartMax) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              {days.length > 0 && (
                <div className="usage-chart-axis">
                  <span>{axisLabel(days[0].date)}</span>
                  <span>{axisLabel(days[days.length - 1].end)}</span>
                </div>
              )}
            </div>

            <div className="usage-section">
              <div className="usage-section-head">
                <span>{t("usage.byModel")}</span>
              </div>
              <div className="usage-models">
                {models.map((m) => (
                  <div key={m.model} className="usage-model-row">
                    <span className="usage-model-name" title={m.model}>
                      {m.model}
                    </span>
                    <span className="usage-model-bar">
                      <i style={{ width: `${(m.tokens / modelMax) * 100}%` }} />
                    </span>
                    <span className="usage-model-tokens">{formatTokens(m.tokens)}</span>
                    <span className="usage-model-cost">
                      {m.cost === null ? "—" : formatCost(m.cost)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="usage-section">
              <div className="usage-section-head">
                <span>{t("usage.byProject")}</span>
              </div>
              <div className="usage-models">
                {projects.map((p) => (
                  <div key={p.project} className="usage-model-row">
                    <span className="usage-model-name" title={p.project}>
                      {p.project}
                    </span>
                    <span className="usage-model-bar">
                      <i style={{ width: `${(p.tokens / projectMax) * 100}%` }} />
                    </span>
                    <span className="usage-model-tokens">{formatTokens(p.tokens)}</span>
                    <span className="usage-model-cost">{formatCost(p.cost)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
    </div>
  );
}
