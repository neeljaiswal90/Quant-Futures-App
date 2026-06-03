/**
 * WebGPU adapter / device / canvas lifecycle for the dashboard.
 *
 * One device is shared across all GPU renderers (depth heatmap, σ shelves,
 * bubbles, future bloom pass) so we pay the adapter/device acquisition cost
 * once. Each renderer brings its own pipeline + bind groups against this
 * shared device.
 *
 * Per the WebGPU smoke test 2026-06-03, the Tauri WebView2 exposes the RTX
 * 4080 via Ada Lovelace, with `timestamp-query`, `subgroups`, `shader-f16`,
 * and `float32-blendable` available. Capability detection here decides
 * which of those we can actually request at device-creation time.
 *
 * Initialization is async and idempotent. If `navigator.gpu` is undefined,
 * adapter request returns null, or device acquisition throws, the function
 * returns a `failed` state and the caller must fall back to Canvas2D.
 */

/** Features we'd LIKE if available. None are required for the depth heatmap. */
const OPTIONAL_FEATURES: GPUFeatureName[] = [
  // Built-in GPU profiling (renderer instruments itself with begin/end timestamps).
  "timestamp-query",
  // Wave-level shader ops for the percentile compute shader in Phase 4.
  "subgroups" as GPUFeatureName,
  // Half-precision floats for shader perf. Nice-to-have.
  "shader-f16",
  // High-precision blending for bloom / glow passes.
  "float32-blendable" as GPUFeatureName,
  // Dual-source blending for advanced compositing.
  "dual-source-blending" as GPUFeatureName,
];

export interface GpuContextOK {
  status: "ok";
  device: GPUDevice;
  adapter: GPUAdapter;
  adapterInfo: GPUAdapterInfo | null;
  /** Subset of OPTIONAL_FEATURES the device actually has. */
  features: Set<GPUFeatureName>;
  /** Preferred canvas format for the system's compositor (usually bgra8unorm on Windows). */
  preferredCanvasFormat: GPUTextureFormat;
}

export interface GpuContextFailed {
  status: "failed";
  /** Human-readable reason; surfaced to fallback logic + console. */
  reason: string;
  /** Stage at which acquisition broke. Used for telemetry. */
  stage: "no-navigator-gpu" | "no-adapter" | "no-device" | "exception";
  /** Original error if one was thrown. */
  error?: unknown;
}

export type GpuContext = GpuContextOK | GpuContextFailed;

let cached: Promise<GpuContext> | null = null;

/**
 * Acquire the shared WebGPU device. Idempotent — subsequent calls return the
 * cached promise so multiple renderers share one device.
 */
export function acquireGpu(): Promise<GpuContext> {
  if (cached === null) {
    cached = doAcquire();
  }
  return cached;
}

async function doAcquire(): Promise<GpuContext> {
  if (typeof navigator === "undefined" || !navigator.gpu) {
    return {
      status: "failed",
      reason: "navigator.gpu is undefined; WebView2 lacks WebGPU support",
      stage: "no-navigator-gpu",
    };
  }

  let adapter: GPUAdapter | null;
  try {
    // High-performance preference routes to the 4080 over integrated graphics.
    adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch (error) {
    return {
      status: "failed",
      reason: `requestAdapter threw: ${describeError(error)}`,
      stage: "exception",
      error,
    };
  }
  if (!adapter) {
    return {
      status: "failed",
      reason: "requestAdapter returned null; no suitable GPU available",
      stage: "no-adapter",
    };
  }

  // Inspect adapter capabilities to know which optional features we can request.
  // adapter.features.forEach exposes entries as `string` per @webgpu/types;
  // we narrow to GPUFeatureName during the membership check below.
  const availableFeatures = new Set<string>();
  adapter.features.forEach((f: string) => availableFeatures.add(f));

  const requestedFeatures: GPUFeatureName[] = OPTIONAL_FEATURES.filter((f) =>
    availableFeatures.has(f as string),
  );

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({ requiredFeatures: requestedFeatures });
  } catch (error) {
    return {
      status: "failed",
      reason: `requestDevice threw: ${describeError(error)}`,
      stage: "exception",
      error,
    };
  }

  // Log device-lost events so a driver hiccup doesn't silently freeze the chart.
  device.lost.then((info) => {
    // eslint-disable-next-line no-console
    console.warn(
      `[gpu] WebGPU device lost — reason=${info.reason} message=${info.message ?? "(none)"}`,
    );
    // Bust the cache so the next acquireGpu() retries the adapter dance.
    cached = null;
  });

  // adapter.info is the modern spec; @webgpu/types only exposes this accessor
  // (legacy requestAdapterInfo() was removed). Older Chromium versions that
  // still need the legacy call are below Edge 122 — well below the WebView2
  // baseline Tauri 2.x bundles, so we don't need the fallback.
  const adapterInfo: GPUAdapterInfo | null = adapter.info ?? null;

  return {
    status: "ok",
    device,
    adapter,
    adapterInfo,
    features: new Set(requestedFeatures),
    preferredCanvasFormat: navigator.gpu.getPreferredCanvasFormat(),
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Configure a canvas's WebGPU context against the shared device. Returns the
 * configured `GPUCanvasContext` or null on failure. Idempotent — safe to call
 * after a canvas resize.
 */
export function configureCanvas(
  canvas: HTMLCanvasElement,
  gpu: GpuContextOK,
): GPUCanvasContext | null {
  const ctx = canvas.getContext("webgpu");
  if (!ctx) return null;
  ctx.configure({
    device: gpu.device,
    format: gpu.preferredCanvasFormat,
    alphaMode: "premultiplied",
  });
  return ctx;
}

/**
 * Resize a canvas to its CSS size × devicePixelRatio. Returns true if the
 * canvas backing store actually changed (caller may want to re-render).
 */
export function resizeCanvas(canvas: HTMLCanvasElement, dpr = window.devicePixelRatio || 1): boolean {
  const targetW = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const targetH = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width === targetW && canvas.height === targetH) return false;
  canvas.width = targetW;
  canvas.height = targetH;
  return true;
}

// WebGPU types come from @webgpu/types (dev dependency, referenced via
// tsconfig.app.json "types"). The `adapter.info` accessor + the legacy
// `requestAdapterInfo()` fallback are both included in that package.
