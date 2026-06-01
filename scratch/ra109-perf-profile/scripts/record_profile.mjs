import fs from "node:fs/promises";
import path from "node:path";

const OUT_DIR = "D:/Quant-futures-app/scratch/ra109-perf-profile";
const URL = "http://127.0.0.1:5173/";
const CDP_PORT = Number(process.env.RA109_CDP_PORT ?? 9333);
const RECORD_MS = 15_000;

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.keepalive = setInterval(() => {}, 1_000);
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result ?? {});
      } else {
        this.events.push(msg);
        this.onEvent?.(msg);
      }
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 90_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
    });
    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  close() {
    clearInterval(this.keepalive);
    this.ws.close();
  }
}

async function cdpFetch(route) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}${route}`);
  if (!res.ok) throw new Error(`${route} failed: ${res.status} ${res.statusText}`);
  return await res.json();
}

async function backendHealth() {
  try {
    const res = await fetch("http://127.0.0.1:8765/health");
    return await res.json();
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

async function backfillSummary() {
  const startedAt = Date.now();
  try {
    const res = await fetch("http://127.0.0.1:8765/api/bookmap-backfill");
    const text = await res.text();
    const elapsedMs = Date.now() - startedAt;
    const payload = JSON.parse(text);
    return {
      elapsedMs,
      bytes: Buffer.byteLength(text),
      generated_at_ns: payload.generated_at_ns,
      through_seq: payload.through_seq,
      price_ticks: Array.isArray(payload.price_ticks) ? payload.price_ticks.length : null,
      depth: Array.isArray(payload.depth) ? payload.depth.length : null,
      limits: payload.limits ?? null,
    };
  } catch (err) {
    return { error: String(err?.message ?? err), elapsedMs: Date.now() - startedAt };
  }
}

async function wsFrameSample(ms = 5_000) {
  return await new Promise((resolve) => {
    const counts = {};
    let bytes = 0;
    let firstSeq = null;
    let lastSeq = null;
    const startedAt = Date.now();
    const ws = new WebSocket("ws://127.0.0.1:8765/ws");
    ws.addEventListener("message", (event) => {
      const raw = String(event.data);
      bytes += Buffer.byteLength(raw);
      try {
        const msg = JSON.parse(raw);
        const family = msg?.payload?.family ?? "unknown";
        counts[family] = (counts[family] ?? 0) + 1;
        if (typeof msg.seq === "number") {
          if (firstSeq === null) firstSeq = msg.seq;
          lastSeq = msg.seq;
        }
      } catch {
        counts.parse_error = (counts.parse_error ?? 0) + 1;
      }
    });
    ws.addEventListener("error", (err) => {
      resolve({ error: String(err?.message ?? err), counts, bytes, durationMs: Date.now() - startedAt });
    }, { once: true });
    setTimeout(() => {
      ws.close();
      const durationMs = Date.now() - startedAt;
      const frames = Object.values(counts).reduce((a, b) => a + b, 0);
      resolve({
        durationMs,
        frames,
        fps: frames / (durationMs / 1000),
        avgBytes: frames ? bytes / frames : 0,
        firstSeq,
        lastSeq,
        deltaSeq: firstSeq === null || lastSeq === null ? null : lastSeq - firstSeq,
        counts,
      });
    }, ms);
  });
}

async function readTraceStream(cdp, streamHandle) {
  let data = "";
  for (;;) {
    const chunk = await cdp.send("IO.read", { handle: streamHandle, size: 1_048_576 });
    data += chunk.data ?? "";
    if (chunk.eof) break;
  }
  await cdp.send("IO.close", { handle: streamHandle });
  return JSON.parse(data);
}

async function waitFor(cdp, predicate, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = cdp.events.find(predicate);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for CDP event");
}

async function setupPage(cdp) {
  const targets = await cdp.send("Target.getTargets");
  for (const target of targets.targetInfos ?? []) {
    if (target.type === "page") {
      await cdp.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
    }
  }
  const target = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const sessionId = attached.sessionId;
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  await cdp.send("Performance.enable", {}, sessionId);
  return sessionId;
}

async function navigateAndWait(cdp, sessionId, url) {
  const startEventCount = cdp.events.length;
  await cdp.send("Page.navigate", { url }, sessionId);
  await waitFor(
    cdp,
    (event) =>
      cdp.events.indexOf(event) >= startEventCount &&
      event.method === "Page.loadEventFired" &&
      event.sessionId === sessionId,
    30_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}

async function pageSnapshot(cdp, sessionId) {
  const expr = `(() => {
    const text = document.body?.innerText ?? "";
    const canvases = Array.from(document.querySelectorAll("canvas")).map((c) => ({
      width: c.width,
      height: c.height,
      clientWidth: c.clientWidth,
      clientHeight: c.clientHeight,
    }));
    return {
      title: document.title,
      url: location.href,
      text: text.slice(0, 1200),
      hasPriceContext: text.includes("PRICE CONTEXT"),
      hasDomLadder: text.includes("DOM LADDER"),
      hasDepthWaiting: text.includes("Waiting for depth"),
      hasLiveFeed: text.includes("LIVE FEED"),
      canvases,
    };
  })()`;
  const result = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId);
  return result.result?.value ?? null;
}

async function startRecording(cdp, sessionId) {
  cdp.events = [];
  await cdp.send("Profiler.enable", {}, sessionId);
  await cdp.send("Profiler.start", {}, sessionId);
  await cdp.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    categories: [
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "disabled-by-default-devtools.timeline.frame",
      "v8",
      "v8.execute",
      "toplevel",
    ].join(","),
  });
}

async function stopRecording(cdp, sessionId) {
  const cpuProfile = await cdp.send("Profiler.stop", {}, sessionId);
  await cdp.send("Tracing.end");
  const complete = await waitFor(cdp, (event) => event.method === "Tracing.tracingComplete", 60_000);
  const trace = await readTraceStream(cdp, complete.params.stream);
  return { cpuProfile: cpuProfile.profile, trace };
}

async function runScenario(cdp, sessionId, name, mode) {
  console.error(`RA109 scenario ${name} start (${mode})`);
  const before = {
    backend: await backendHealth(),
    wsSample: await wsFrameSample(5_000),
  };
  let coldBackfill = null;
  let snapshotBeforeRecord = null;
  if (mode === "hydration") {
    coldBackfill = await backfillSummary();
    await startRecording(cdp, sessionId);
    await cdp.send("Page.navigate", { url: `${URL}?ra109=${Date.now()}` }, sessionId);
    await waitFor(cdp, (event) => event.method === "Page.loadEventFired" && event.sessionId === sessionId, 30_000);
    await new Promise((resolve) => setTimeout(resolve, RECORD_MS));
  } else {
    await navigateAndWait(cdp, sessionId, `${URL}?ra109=${name}-${Date.now()}`);
    snapshotBeforeRecord = await pageSnapshot(cdp, sessionId);
    await startRecording(cdp, sessionId);
    await new Promise((resolve) => setTimeout(resolve, RECORD_MS));
  }
  const recording = await stopRecording(cdp, sessionId);
  const after = {
    backend: await backendHealth(),
    wsSample: await wsFrameSample(5_000),
    page: await pageSnapshot(cdp, sessionId),
  };
  const result = {
    scenario: name,
    mode,
    url: URL,
    recordMs: RECORD_MS,
    timestamp: new Date().toISOString(),
    before,
    coldBackfill,
    snapshotBeforeRecord,
    after,
    cpuProfile: recording.cpuProfile,
    trace: recording.trace,
  };
  const outPath = path.join(OUT_DIR, `scenario-${name}.json`);
  await fs.writeFile(outPath, JSON.stringify(result));
  console.error(`RA109 scenario ${name} wrote ${outPath}`);
  return {
    scenario: name,
    path: outPath,
    before,
    coldBackfill,
    after,
    traceEvents: recording.trace.traceEvents?.length ?? 0,
    cpuNodes: recording.cpuProfile.nodes?.length ?? 0,
  };
}

async function main() {
  console.error(`RA109 recorder start, cdp port ${CDP_PORT}`);
  await fs.mkdir(OUT_DIR, { recursive: true });
  const version = await cdpFetch("/json/version");
  console.error(`RA109 connected target ${version.Browser}`);
  const cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.open();
  const sessionId = await setupPage(cdp);
  console.error(`RA109 page session ${sessionId}`);
  const summaries = [];
  summaries.push(await runScenario(cdp, sessionId, "a", "steady"));
  summaries.push(await runScenario(cdp, sessionId, "b", "hydration"));
  summaries.push(await runScenario(cdp, sessionId, "c", "live-burst"));
  await fs.writeFile(path.join(OUT_DIR, "recording_summary.json"), JSON.stringify(summaries, null, 2));
  cdp.close();
  console.log(JSON.stringify(summaries, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
