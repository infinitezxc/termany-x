import { useEffect, useMemo, useState } from "react";
import { useAgentConfigs } from "../agents";
import { apiPath } from "../api";
import { UsageSelect } from "./Select";
import { useI18n } from "../i18n";
import { focusedSshHost, useStore } from "../state/store";
import { ChartIcon } from "./icons";

interface UsageRow {
  agent: string;
  project: string | null; // session cwd
  date: string; // local YYYY-MM-DD
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Best-effort $/MTok price list for cost estimation. Prefix-matched against
 * the model id recorded in the transcripts; unmatched models still count
 * toward token totals but are excluded from the cost card (with a note).
 * Claude cache pricing: reads 0.1x input, writes 1.25x input.
 */
const PRICING: Array<{ prefix: string; input: number; output: number; cacheRead: number; cacheWrite: number }> = [
  { prefix: "claude-fable-5", input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { prefix: "claude-opus-4-1", input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { prefix: "claude-opus-4-2", input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { prefix: "claude-opus-4", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { prefix: "claude-sonnet", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: "claude-3-7-sonnet", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: "claude-3-5-sonnet", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { prefix: "claude-haiku-4-5", input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { prefix: "claude-3-5-haiku", input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  { prefix: "gpt-5-mini", input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  { prefix: "gpt-5-nano", input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 },
  { prefix: "gpt-5", input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  { prefix: "o3", input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
];

function priceFor(model: string) {
  return PRICING.find((p) => model.startsWith(p.prefix)) ?? null;
}

function rowCost(r: UsageRow): number | null {
  const p = priceFor(r.model);
  if (!p) return null;
  return (
    (r.input * p.input + r.output * p.output + r.cacheRead * p.cacheRead + r.cacheWrite * p.cacheWrite) / 1e6
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

/** Collapse the home-dir prefix so project paths read short (same as AgentHistory). */
function tildify(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

const RANGES = [
  { key: "today", labelKey: "usage.range.today" },
  { key: "week", labelKey: "usage.range.week" },
  { key: "month", labelKey: "usage.range.month" },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];

function rangeCutoff(range: RangeKey): string {
  const d = new Date();
  if (range === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
  else if (range === "month") d.setDate(1);
  return localDateString(d);
}

const MAX_CHART_DAYS = 31;

/**
 * Agent token-usage dashboard (the SideRail chart button): totals + estimated
 * cost cards, a daily input/output bar chart, and a per-model breakdown, all
 * computed client-side from range-bounded /api/agent-usage rows. Cache tokens
 * are shown in the cards and cost but excluded from the chart — they'd dwarf
 * everything else. Opened from an SSH pane, it shows that host's usage — its
 * agents run there (same as AgentHistory).
 */
export function AgentUsage() {
  const { t } = useI18n();
  const agentConfigs = useAgentConfigs();
  const [rows, setRows] = useState<UsageRow[] | null | undefined>(undefined);
  const [stale, setStale] = useState(false);
  const [range, setRange] = useState<RangeKey>("today");
  const [agent, setAgent] = useState("all");
  const [project, setProject] = useState("all");
  // Frozen at open, so focusing another pane doesn't swap the host mid-use.
  const [ssh] = useState(() => focusedSshHost(useStore.getState()));

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    setRows(undefined);
    const params = new URLSearchParams({ since: rangeCutoff(range) });
    if (ssh) params.set("session", ssh.session);
    fetch(apiPath(`/api/agent-usage?${params}`), { signal: abort.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        if (!cancelled) setRows(Array.isArray(data.rows) ? data.rows : []);
      })
      .catch((e: Error) => {
        if (cancelled || e.name === "AbortError") return;
        // A 404 on a route this build ships means the backend answering us is
        // older than the UI — an upgrade left the previous release's server
        // holding the port. Say so instead of blaming the data.
        setStale(e.message === "404");
        setRows(null);
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [range, ssh]);

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
    const cutoff = rangeCutoff(range);
    return rows.filter(
      (r) =>
        (agent === "all" || r.agent === agent) &&
        (project === "all" || projectName(r) === project) &&
        r.date >= cutoff
    );
  }, [rows, range, agent, project]);

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
  // reads as a calendar, not just a list of active days.
  const days = useMemo(() => {
    const byDate = new Map<string, { input: number; output: number }>();
    for (const r of filtered) {
      const d = byDate.get(r.date) ?? { input: 0, output: 0 };
      d.input += r.input;
      d.output += r.output;
      byDate.set(r.date, d);
    }
    // The chart always ends today and starts at the selected range cutoff.
    const cutoff = rangeCutoff(range);
    if (!cutoff) return [];
    const span = Math.floor((Date.now() - new Date(`${cutoff}T00:00:00`).getTime()) / 86400000) + 1;
    const count = Math.min(Math.max(span, 1), MAX_CHART_DAYS);
    const out: Array<{ date: string; input: number; output: number }> = [];
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const date = localDateString(d);
      const v = byDate.get(date);
      out.push({ date, input: v?.input ?? 0, output: v?.output ?? 0 });
    }
    return out;
  }, [filtered, range]);

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
            <UsageSelect
              width={132}
              value={range}
              onChange={(v) => setRange(v as RangeKey)}
              options={RANGES.map((r) => ({ value: r.key, label: t(r.labelKey) }))}
            />
          </div>
        </div>

        {rows === undefined && <div className="search-empty">{t("usage.loading")}</div>}
        {rows === null && (
          <div className="search-empty">{t(stale ? "server.stale" : "usage.error")}</div>
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
                <span>{t("usage.daily")}</span>
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
                    title={`${d.date}\n${t("usage.chartTip", {
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
                  <span>{days[0].date.slice(5)}</span>
                  <span>{days[days.length - 1].date.slice(5)}</span>
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
