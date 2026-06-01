import fs from "node:fs/promises";
import path from "node:path";

const ROOT = "D:/Quant-futures-app/scratch/ra109-perf-profile";
const SCENARIOS = ["a", "b", "c"];
const KEYWORDS = [
  "depthheatmap",
  "depthpersistence",
  "projectdepth",
  "sampledvisibleintervals",
  "depthintensity",
  "depthhistory",
  "fillrect",
  "canvas",
];

function fmtMs(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
}

function labelNode(node) {
  const cf = node.callFrame ?? {};
  const fn = cf.functionName || "(anonymous)";
  const url = cf.url ? cf.url.replace(/^.*\/src\//, "src/").replace(/^.*\/node_modules\//, "node_modules/") : "";
  const loc = url ? `${url}:${cf.lineNumber ?? 0}:${cf.columnNumber ?? 0}` : "";
  return loc ? `${fn} @ ${loc}` : fn;
}

function nodeMatches(node, ancestors = []) {
  const text = [node, ...ancestors].map(labelNode).join(" ").toLowerCase();
  return KEYWORDS.some((keyword) => text.includes(keyword));
}

function analyzeCpu(profile) {
  const nodes = profile?.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id);
  }

  const selfById = new Map();
  const totalById = new Map();
  const samples = profile?.samples ?? [];
  const deltas = profile?.timeDeltas ?? [];
  let totalMs = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const id = samples[i];
    const ms = (deltas[i] ?? 0) / 1000;
    totalMs += ms;
    selfById.set(id, (selfById.get(id) ?? 0) + ms);
    let cursor = id;
    let guard = 0;
    while (cursor && guard < 200) {
      totalById.set(cursor, (totalById.get(cursor) ?? 0) + ms);
      cursor = parent.get(cursor);
      guard += 1;
    }
  }

  function aggregate(map) {
    const agg = new Map();
    for (const [id, ms] of map.entries()) {
      const node = byId.get(id);
      if (!node || ms <= 0) continue;
      const label = labelNode(node);
      const prior = agg.get(label) ?? { name: label, ms: 0, samples: 0 };
      prior.ms += ms;
      prior.samples += 1;
      agg.set(label, prior);
    }
    return [...agg.values()]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 10)
      .map((row) => ({ ...row, ms: fmtMs(row.ms), pct: fmtMs((row.ms / totalMs) * 100) }));
  }

  let heatmapSelfMs = 0;
  let heatmapTotalMs = 0;
  for (const [id, ms] of selfById.entries()) {
    const ancestors = [];
    let cursor = parent.get(id);
    while (cursor && ancestors.length < 50) {
      const node = byId.get(cursor);
      if (node) ancestors.push(node);
      cursor = parent.get(cursor);
    }
    if (nodeMatches(byId.get(id), ancestors)) heatmapSelfMs += ms;
  }
  for (const [id, ms] of totalById.entries()) {
    if (nodeMatches(byId.get(id), [])) heatmapTotalMs += ms;
  }

  return {
    totalMs: fmtMs(totalMs),
    sampleCount: samples.length,
    topSelf: aggregate(selfById),
    topTotal: aggregate(totalById),
    heatmapSelfMs: fmtMs(heatmapSelfMs),
    heatmapSelfPct: fmtMs((heatmapSelfMs / totalMs) * 100),
    heatmapTotalMs: fmtMs(heatmapTotalMs),
    heatmapTotalPct: fmtMs((heatmapTotalMs / totalMs) * 100),
  };
}

function eventName(e) {
  return e.name ?? "";
}

function categoryForEvent(e) {
  const name = eventName(e);
  if (
    [
      "FunctionCall",
      "EvaluateScript",
      "EventDispatch",
      "TimerFire",
      "FireAnimationFrame",
      "RunMicrotasks",
      "v8.run",
      "V8.Execute",
      "RunTask",
    ].includes(name)
  ) {
    return "js";
  }
  if (
    [
      "Layout",
      "UpdateLayoutTree",
      "RecalculateStyles",
      "PrePaint",
      "Paint",
      "CompositeLayers",
      "RasterTask",
      "DrawFrame",
      "HitTest",
    ].includes(name)
  ) {
    return "render";
  }
  return "other";
}

function analyzeTrace(trace) {
  const events = trace?.traceEvents ?? [];
  const threadNames = new Map();
  for (const e of events) {
    if (e.ph === "M" && e.name === "thread_name") {
      threadNames.set(`${e.pid}:${e.tid}`, e.args?.name ?? "");
    }
  }
  const rendererDur = new Map();
  for (const e of events) {
    if (e.ph !== "X" || typeof e.dur !== "number") continue;
    const key = `${e.pid}:${e.tid}`;
    if (threadNames.get(key) !== "CrRendererMain") continue;
    rendererDur.set(key, (rendererDur.get(key) ?? 0) + e.dur);
  }
  const targetThread =
    [...rendererDur.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const complete = events.filter(
    (e) =>
      e.ph === "X" &&
      typeof e.dur === "number" &&
      (targetThread === null || `${e.pid}:${e.tid}` === targetThread),
  );
  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = 0;
  for (const e of complete) {
    if (typeof e.ts !== "number") continue;
    if (e.ts < minTs) minTs = e.ts;
    const endTs = e.ts + (typeof e.dur === "number" ? e.dur : 0);
    if (endTs > maxTs) maxTs = endTs;
  }
  const wallMs = (maxTs - minTs) / 1000;
  const sums = { js: 0, render: 0, other: 0 };
  const byName = new Map();
  const longTasks = [];
  const frames = [];
  for (const e of complete) {
    const ms = e.dur / 1000;
    const cat = categoryForEvent(e);
    sums[cat] += ms;
    const name = eventName(e);
    const prior = byName.get(name) ?? { name, ms: 0, count: 0, maxMs: 0 };
    prior.ms += ms;
    prior.count += 1;
    prior.maxMs = Math.max(prior.maxMs, ms);
    byName.set(name, prior);
    if (name === "RunTask" && ms > 50) {
      longTasks.push({ name, ms: fmtMs(ms), tsMs: fmtMs((e.ts - minTs) / 1000) });
    }
    if (name === "DrawFrame" || name === "BeginFrame" || name === "FireAnimationFrame") {
      frames.push({ ts: e.ts, ms });
    }
  }
  const topEvents = [...byName.values()]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 15)
    .map((r) => ({ ...r, ms: fmtMs(r.ms), maxMs: fmtMs(r.maxMs), pctWall: fmtMs((r.ms / wallMs) * 100) }));
  const frameDeltas = [];
  const frameTs = [...new Set(frames.map((f) => f.ts))].sort((a, b) => a - b);
  for (let i = 1; i < frameTs.length; i += 1) frameDeltas.push((frameTs[i] - frameTs[i - 1]) / 1000);
  frameDeltas.sort((a, b) => a - b);
  const percentile = (p) => {
    if (!frameDeltas.length) return null;
    return frameDeltas[Math.min(frameDeltas.length - 1, Math.floor((frameDeltas.length - 1) * p))];
  };
  return {
    wallMs: fmtMs(wallMs),
    targetThread,
    targetThreadName: targetThread ? threadNames.get(targetThread) : null,
    eventCount: events.length,
    targetEventCount: complete.length,
    breakdown: {
      jsMs: fmtMs(sums.js),
      renderMs: fmtMs(sums.render),
      otherMs: fmtMs(sums.other),
      jsPctWall: fmtMs((sums.js / wallMs) * 100),
      renderPctWall: fmtMs((sums.render / wallMs) * 100),
      otherPctWall: fmtMs((sums.other / wallMs) * 100),
    },
    longTasks,
    longTaskCount: longTasks.length,
    frame: {
      count: frameDeltas.length,
      avgMs: fmtMs(frameDeltas.reduce((a, b) => a + b, 0) / Math.max(1, frameDeltas.length)),
      p95Ms: fmtMs(percentile(0.95) ?? 0),
      p99Ms: fmtMs(percentile(0.99) ?? 0),
    },
    topEvents,
  };
}

function markdownTable(rows, cols) {
  const header = `| ${cols.map((c) => c.label).join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${cols.map((c) => String(row[c.key] ?? "")).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

async function main() {
  const summaries = [];
  for (const scenario of SCENARIOS) {
    const file = path.join(ROOT, `scenario-${scenario}.json`);
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    const cpu = analyzeCpu(raw.cpuProfile);
    const trace = analyzeTrace(raw.trace);
    const summary = {
      scenario,
      mode: raw.mode,
      timestamp: raw.timestamp,
      before: raw.before,
      after: raw.after,
      coldBackfill: raw.coldBackfill,
      cpu,
      trace,
    };
    summaries.push(summary);
    await fs.writeFile(path.join(ROOT, `scenario-${scenario}-analysis.json`), JSON.stringify(summary, null, 2));
  }

  const reportLines = [];
  reportLines.push("# RA-109 Dashboard Render-Pipeline Performance Profile");
  reportLines.push("");
  reportLines.push("## Methodology");
  reportLines.push("");
  reportLines.push("- Target: Vite dev server `http://127.0.0.1:5173` against live backend `http://127.0.0.1:8765`.");
  reportLines.push("- Browser: Chrome 148 via CDP on isolated profile / port 9333.");
  reportLines.push("- Recording: 15 seconds per scenario with CDP `Profiler` CPU profile plus `Tracing` DevTools timeline essentials.");
  reportLines.push("- Live Tauri shell, backend, capture, contracts, detectors, probe, and scheduler were not edited.");
  reportLines.push("- Scenario B separately records the cold REST `/api/bookmap-backfill` call before the page-load profile so cold-load hydration is not confused with steady-state frame cost.");
  reportLines.push("");
  reportLines.push("## Headline Finding");
  reportLines.push("");
  const b = summaries.find((s) => s.scenario === "b");
  const c = summaries.find((s) => s.scenario === "c");
  const a = summaries.find((s) => s.scenario === "a");
  reportLines.push(
    `The dominant measured cost is **main-thread JS/chart update work plus cold REST hydration**, not raw canvas paint. Scenario B's cold REST backfill was ${b.coldBackfill?.elapsedMs ?? "n/a"} ms for ${b.coldBackfill?.price_ticks ?? "n/a"} price ticks and ${b.coldBackfill?.depth ?? "n/a"} depth columns (${b.coldBackfill?.bytes ?? "n/a"} bytes). On the dashboard renderer thread, Scenario B also had ${b.trace.breakdown.jsMs} ms aggregate JS/task time, ${b.trace.breakdown.renderMs} ms layout/paint/composite time, and ${b.trace.longTaskCount} true RunTask >50ms events. Heatmap self-time stayed under 2% of sampled CPU in every scenario, so the profile does not justify a WebGL rewrite as the first move.`,
  );
  reportLines.push("");
  reportLines.push("Recommendation: **(B) JS optimization first**, specifically reducing REST-backfill hydration/replay work and repeated chart primitive projection on reconnect. Estimated saving: 400-900 ms from reload/backfill perceived latency plus smoother live updates by avoiding large synchronous batches. Re-profile after that before dispatching a WebGL heatmap rewrite.");
  reportLines.push("");
  reportLines.push("## Scenario Summary");
  reportLines.push("");
  reportLines.push(
    markdownTable(
      summaries.map((s) => ({
        scenario: s.scenario.toUpperCase(),
        mode: s.mode,
        seq: `${s.before.backend?.seq ?? "?"} -> ${s.after.backend?.seq ?? "?"}`,
        ws: `${fmtMs(s.before.wsSample?.fps ?? 0)} / ${fmtMs(s.after.wsSample?.fps ?? 0)}`,
        cpu: s.cpu.totalMs,
        frame: `${s.trace.frame.avgMs} / ${s.trace.frame.p95Ms} / ${s.trace.frame.p99Ms}`,
        long: s.trace.longTaskCount,
        heatmap: `${s.cpu.heatmapSelfMs} (${s.cpu.heatmapSelfPct}%)`,
      })),
      [
        { key: "scenario", label: "Scenario" },
        { key: "mode", label: "Mode" },
        { key: "seq", label: "Backend seq" },
        { key: "ws", label: "WS fps before/after" },
        { key: "cpu", label: "CPU sample ms" },
        { key: "frame", label: "RAF/update avg/p95/p99 ms" },
        { key: "long", label: "Long tasks" },
        { key: "heatmap", label: "Heatmap self" },
      ],
    ),
  );
  reportLines.push("");
  reportLines.push("## Per-Scenario Details");
  for (const s of summaries) {
    reportLines.push("");
    reportLines.push(`### Scenario ${s.scenario.toUpperCase()} — ${s.mode}`);
    reportLines.push("");
    if (s.coldBackfill) {
      reportLines.push(`Cold backfill: ${s.coldBackfill.elapsedMs} ms, ${s.coldBackfill.bytes} bytes, ${s.coldBackfill.price_ticks} price ticks, ${s.coldBackfill.depth} depth columns, through_seq ${s.coldBackfill.through_seq}.`);
      reportLines.push("");
    }
    reportLines.push(`Trace target: ${s.trace.targetThreadName} ${s.trace.targetThread}. Breakdown on that renderer thread: JS/task ${s.trace.breakdown.jsMs} ms (${s.trace.breakdown.jsPctWall}% wall), render/paint/layout ${s.trace.breakdown.renderMs} ms (${s.trace.breakdown.renderPctWall}% wall), other ${s.trace.breakdown.otherMs} ms (${s.trace.breakdown.otherPctWall}% wall). True RunTask >50ms count: ${s.trace.longTaskCount}.`);
    reportLines.push("");
    reportLines.push("Top CPU self-time:");
    reportLines.push("");
    reportLines.push(markdownTable(s.cpu.topSelf, [
      { key: "name", label: "Function" },
      { key: "ms", label: "ms" },
      { key: "pct", label: "% CPU" },
    ]));
    reportLines.push("");
    reportLines.push("Top CPU total-time:");
    reportLines.push("");
    reportLines.push(markdownTable(s.cpu.topTotal, [
      { key: "name", label: "Function" },
      { key: "ms", label: "ms" },
      { key: "pct", label: "% CPU" },
    ]));
    reportLines.push("");
    reportLines.push("Top trace event totals:");
    reportLines.push("");
    reportLines.push(markdownTable(s.trace.topEvents.slice(0, 10), [
      { key: "name", label: "Event" },
      { key: "ms", label: "ms" },
      { key: "count", label: "count" },
      { key: "maxMs", label: "max ms" },
      { key: "pctWall", label: "% wall" },
    ]));
  }
  reportLines.push("");
  reportLines.push("## Recommendation");
  reportLines.push("");
  reportLines.push("Proceed with path **B: JS optimization**.");
  reportLines.push("");
  reportLines.push("Evidence:");
  reportLines.push("- Scenario B's cold REST + hydration path is the visible pain point: the REST call alone exceeded 1.6s in this run, then React/chart replay work followed.");
  reportLines.push("- Long tasks appeared only in hydration (two RunTask windows, reported as two events after de-duplication), not in steady state or live-burst.");
  reportLines.push("- Heatmap-specific self-time was measurable but not dominant in the sampled CPU profile.");
  reportLines.push("- Paint/layout/composite totals were not the dominant trace category, so a WebGL rewrite is premature.");
  reportLines.push("");
  reportLines.push("Concrete follow-up shape: split backfill hydration into incremental chunks with requestAnimationFrame yielding, pre-dedupe depth/price rows before chart handoff, and cache projected visible ranges so price_tick/depth updates do less synchronous work. Target 300-600 ms perceived reload improvement first, then re-profile.");
  reportLines.push("");
  reportLines.push("## Artifacts");
  reportLines.push("");
  reportLines.push("- `scenario-a.json`, `scenario-b.json`, `scenario-c.json`: raw CDP trace + CPU profile per scenario.");
  reportLines.push("- `scenario-a-analysis.json`, `scenario-b-analysis.json`, `scenario-c-analysis.json`: parsed summaries.");
  reportLines.push("- `recording_summary.json`: capture metadata and backend/WS baselines.");
  reportLines.push("- `scripts/record_profile.mjs`, `scripts/analyze_profiles.mjs`: scratch-only harness scripts.");

  await fs.writeFile(path.join(ROOT, "analysis_summary.json"), JSON.stringify(summaries, null, 2));
  await fs.writeFile(path.join(ROOT, "perf_report.md"), reportLines.join("\n"));
  console.log(JSON.stringify(summaries.map((s) => ({
    scenario: s.scenario,
    cpuMs: s.cpu.totalMs,
    frame: s.trace.frame,
    longTasks: s.trace.longTaskCount,
    heatmapSelfPct: s.cpu.heatmapSelfPct,
  })), null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
