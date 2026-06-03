/**
 * WebGPU depth heatmap renderer.
 *
 * Replaces the per-cell `fillRect()` loop in `depthHeatmap.ts` with a single
 * instanced draw call. For 75k cells (the current Canvas2D cap), this is the
 * difference between ~10-30ms of CPU issue cost per frame and <1ms total.
 *
 * Per-instance attributes (24 bytes = 6 × f32):
 *   time_start    // f32, units = camera.time_range units (typically seconds)
 *   time_width    // f32
 *   price_center  // f32, MNQ index price (e.g. 30573.50)
 *   price_height  // f32, usually MNQ_TICK (0.25)
 *   intensity     // f32, 0..1
 *   side          // f32, 0.0 (bid/green) or 1.0 (ask/red)
 *
 * Public API:
 *   const r = await DepthHeatmapGPU.create(canvas);
 *   r.setCamera({ timeRange: [...], priceRange: [...] });
 *   r.setInstances(float32Array);  // length must be multiple of 6
 *   r.render();
 *   r.destroy();
 */

import { acquireGpu, configureCanvas, resizeCanvas, type GpuContextOK } from "./context";
import shaderSrc from "./depthHeatmap.wgsl?raw";

/** 6 × f32 per instance — see comment at top. */
export const INSTANCE_STRIDE_FLOATS = 6;
export const INSTANCE_STRIDE_BYTES = INSTANCE_STRIDE_FLOATS * 4;

export const DEPTH_HEATMAP_MAX_INSTANCES = 100_000;

/**
 * Uniform layout matches the WGSL `Camera` struct.
 * RA-115 Phase 2: extended from 80 → 96 bytes for bloom params.
 *   0..15   time_range (8) + price_range (8)
 *   16..31  canvas_size (8) + pad (8)
 *   32..47  bid_color (16, vec4 aligned)
 *   48..63  ask_color (16)
 *   64..79  intensity_power + alpha_floor + alpha_ceil + pad (4 × 4)
 *   80..95  bloom_threshold + bloom_radius_px + pad (4 × 4)
 */
const CAMERA_UBO_BYTES = 96;

export interface DepthCameraInputs {
  /** [start, end] in same units as instance time_start (typically seconds since epoch). */
  timeRange: [number, number];
  /** [topPrice, bottomPrice]. Top is the higher index price. */
  priceRange: [number, number];
  /** Optional overrides. Defaults match the Canvas2D constants from depthHeatmap.ts. */
  intensityPower?: number;
  alphaFloor?: number;
  alphaCeil?: number;
  bidColor?: [number, number, number, number];
  askColor?: [number, number, number, number];
  /**
   * RA-115 Phase 2: bloom on bright walls. Cells with intensity above
   * `bloomThreshold` (default 0.6) get a soft halo extending up to
   * `bloomRadiusPx` pixels (default 6.0) in each direction. Set radius to 0
   * to disable. The halo's intensity scales with how far above threshold
   * the cell's intensity is (just-above = thin halo; saturated = full halo).
   */
  bloomThreshold?: number;
  bloomRadiusPx?: number;
}

const DEFAULT_BID: [number, number, number, number] = [0.18, 0.56, 0.34, 1.0];
const DEFAULT_ASK: [number, number, number, number] = [0.78, 0.25, 0.27, 1.0];

export class DepthHeatmapGPU {
  private gpu: GpuContextOK;
  private canvas: HTMLCanvasElement;
  private ctx: GPUCanvasContext;
  private pipeline: GPURenderPipeline;
  private cameraBuf: GPUBuffer;
  private instanceBuf: GPUBuffer;
  private bindGroup: GPUBindGroup;
  private instanceCount = 0;
  private cameraScratch = new Float32Array(CAMERA_UBO_BYTES / 4);

  static async create(canvas: HTMLCanvasElement): Promise<DepthHeatmapGPU> {
    const gpu = await acquireGpu();
    if (gpu.status !== "ok") {
      throw new Error(`WebGPU unavailable: ${gpu.reason}`);
    }
    resizeCanvas(canvas);
    const ctx = configureCanvas(canvas, gpu);
    if (!ctx) {
      throw new Error("canvas.getContext('webgpu') returned null");
    }
    return new DepthHeatmapGPU(canvas, ctx, gpu);
  }

  private constructor(canvas: HTMLCanvasElement, ctx: GPUCanvasContext, gpu: GpuContextOK) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.gpu = gpu;
    const { device, preferredCanvasFormat } = gpu;

    // Shader module + render pipeline
    const shader = device.createShaderModule({ code: shaderSrc, label: "depthHeatmap.wgsl" });

    const bindGroupLayout = device.createBindGroupLayout({
      label: "depthHeatmap.bgl",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "read-only-storage" },
        },
      ],
    });

    this.pipeline = device.createRenderPipeline({
      label: "depthHeatmap.pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module: shader, entryPoint: "vs" },
      fragment: {
        module: shader,
        entryPoint: "fs",
        targets: [
          {
            format: preferredCanvasFormat,
            // Standard premultiplied-alpha blending — matches the canvas alphaMode.
            blend: {
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-strip" },
    });

    this.cameraBuf = device.createBuffer({
      label: "depthHeatmap.camera",
      size: CAMERA_UBO_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.instanceBuf = device.createBuffer({
      label: "depthHeatmap.instances",
      size: DEPTH_HEATMAP_MAX_INSTANCES * INSTANCE_STRIDE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.bindGroup = device.createBindGroup({
      label: "depthHeatmap.bg",
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuf } },
        { binding: 1, resource: { buffer: this.instanceBuf } },
      ],
    });
  }

  /**
   * Update the camera uniform. Cheap (80 bytes per write).
   * Safe to call every frame; the driver buffers internally.
   */
  setCamera(c: DepthCameraInputs): void {
    const s = this.cameraScratch;
    s[0] = c.timeRange[0];
    s[1] = c.timeRange[1];
    s[2] = c.priceRange[0]; // top
    s[3] = c.priceRange[1]; // bottom
    s[4] = this.canvas.width;
    s[5] = this.canvas.height;
    s[6] = 0; // pad
    s[7] = 0; // pad
    const bid = c.bidColor ?? DEFAULT_BID;
    s[8] = bid[0];
    s[9] = bid[1];
    s[10] = bid[2];
    s[11] = bid[3];
    const ask = c.askColor ?? DEFAULT_ASK;
    s[12] = ask[0];
    s[13] = ask[1];
    s[14] = ask[2];
    s[15] = ask[3];
    s[16] = c.intensityPower ?? 2.0;
    s[17] = c.alphaFloor ?? 0.06;
    s[18] = c.alphaCeil ?? 1.0;
    s[19] = 0; // pad
    // RA-115 Phase 2: bloom params at offset 80
    s[20] = c.bloomThreshold ?? 0.6;
    s[21] = c.bloomRadiusPx ?? 6.0;
    s[22] = 0; // pad
    s[23] = 0; // pad
    this.gpu.device.queue.writeBuffer(this.cameraBuf, 0, s.buffer, s.byteOffset, CAMERA_UBO_BYTES);
  }

  /**
   * Upload per-instance attributes. `data` is a flat Float32Array of cells,
   * 6 floats per cell. Length must be a multiple of 6.
   */
  setInstances(data: Float32Array): void {
    if (data.length % INSTANCE_STRIDE_FLOATS !== 0) {
      throw new Error(
        `instance array length ${data.length} is not a multiple of ${INSTANCE_STRIDE_FLOATS}`,
      );
    }
    const count = data.length / INSTANCE_STRIDE_FLOATS;
    if (count > DEPTH_HEATMAP_MAX_INSTANCES) {
      throw new Error(
        `instance count ${count} exceeds cap ${DEPTH_HEATMAP_MAX_INSTANCES}; raise DEPTH_HEATMAP_MAX_INSTANCES`,
      );
    }
    this.instanceCount = count;
    this.gpu.device.queue.writeBuffer(
      this.instanceBuf,
      0,
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
  }

  /**
   * Render one frame. Returns an awaitable for queue submission completion
   * (useful for perf profiling; ignore for normal rAF rendering).
   */
  render(): Promise<undefined> {
    const device = this.gpu.device;
    // Re-configure canvas if it resized (cheap; WebGPU canvas tracks backing size).
    if (resizeCanvas(this.canvas)) {
      this.ctx.configure({
        device,
        format: this.gpu.preferredCanvasFormat,
        alphaMode: "premultiplied",
      });
    }
    const encoder = device.createCommandEncoder({ label: "depthHeatmap.encoder" });
    const pass = encoder.beginRenderPass({
      label: "depthHeatmap.pass",
      colorAttachments: [
        {
          view: this.ctx.getCurrentTexture().createView(),
          // Clear with transparent so the underlying Lightweight Charts canvas shows through.
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    if (this.instanceCount > 0) {
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      // 4 vertices per quad (triangle-strip), N instances
      pass.draw(4, this.instanceCount, 0, 0);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
    return device.queue.onSubmittedWorkDone();
  }

  destroy(): void {
    this.cameraBuf.destroy();
    this.instanceBuf.destroy();
    // Note: we don't destroy the shared device — other renderers may still use it.
  }

  /** Diagnostic: current instance count + adapter info. Used by the perf overlay. */
  diagnostics(): { instances: number; vendor: string; architecture: string } {
    return {
      instances: this.instanceCount,
      vendor: this.gpu.adapterInfo?.vendor ?? "(unknown)",
      architecture: this.gpu.adapterInfo?.architecture ?? "(unknown)",
    };
  }
}
