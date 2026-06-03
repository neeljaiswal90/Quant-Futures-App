/**
 * Bookmap-parity heatmap renderer — texture-based, continuous-gradient.
 *
 * Path A Week 1 foundation. Replaces the per-cell instanced rendering with
 * a single fullscreen-quad pass that samples a 2D R32_FLOAT texture via
 * hardware bilinear filtering. The texture stores the persistence-
 * accumulator state on a `(column × price)` grid. Bilinear sampling between
 * adjacent texels = smooth gradient. This is the architectural shift that
 * gets us out of "visible cells" territory and into Bookmap-style heatmap.
 *
 * Texture encoding (signed single channel):
 *   texel = 0     → no liquidity
 *   texel > 0     → bid-side, magnitude in [0,1] = intensity
 *   texel < 0     → ask-side, magnitude in [0,1] = intensity
 *
 * Ring buffer in column axis: the texture is updated incrementally as new
 * depth payloads arrive. A `ringOffset` uniform rotates the lookup so the
 * newest column always sits at the right edge of the screen.
 *
 * Status: Day 1 of Week 1 (foundation only). NOT YET integrated into the
 * live dashboard. Wire up via `useDepthHeatmap` in Day 2.
 */

import { acquireGpu, configureCanvas, resizeCanvas, type GpuContextOK } from "./context";
import shaderSrc from "./heatmapTexture.wgsl?raw";

/** Number of price-bucket rows in the heatmap texture. */
export const HEATMAP_PRICE_BUCKETS = 512;
/** Number of column slots in the heatmap texture's ring buffer. */
export const HEATMAP_COLUMN_CAPACITY = 512;

/** Total bytes of the texture. R32_FLOAT × 512 × 512 = 1 MB. */
const TEXTURE_BYTES =
  HEATMAP_PRICE_BUCKETS * HEATMAP_COLUMN_CAPACITY * 4;

/**
 * Camera UBO layout — must match WGSL Camera struct in heatmapTexture.wgsl.
 *
 *   0..7    time_range vec2f
 *   8..15   price_range vec2f
 *  16..23   canvas_size vec2f
 *  24..27   ring_offset f32
 *  28..31   ring_capacity f32
 *  32..35   intensity_power f32
 *  36..39   alpha_floor f32
 *  40..43   alpha_ceil f32
 *  44..47   edge_fade_px f32
 *  48..55   _pad vec2f
 *
 * Total: 56 bytes. Pad to next 16-byte boundary → 64 bytes.
 */
const CAMERA_UBO_BYTES = 64;

export interface HeatmapTextureCameraInputs {
  timeRange: [number, number];
  /** [topPrice, bottomPrice]; top is higher. */
  priceRange: [number, number];
  /** Ring-buffer index of the NEWEST column (0..ringCapacity-1). */
  ringOffset: number;
  intensityPower?: number;
  alphaFloor?: number;
  alphaCeil?: number;
  edgeFadePx?: number;
}

/**
 * Owns the heatmap texture + the fullscreen-quad render pipeline.
 *
 * Day 1 scope: lifecycle (create/destroy), texture allocation, basic
 * camera-uniform write, fullscreen-quad render path. The CPU-side
 * `writeColumn()` API is sketched but not yet wired into the depth
 * persistence accumulator — Day 2 work.
 */
export class HeatmapTexture {
  private gpu: GpuContextOK;
  private canvas: HTMLCanvasElement;
  private ctx: GPUCanvasContext;
  private pipeline: GPURenderPipeline;
  private cameraBuf: GPUBuffer;
  private texture: GPUTexture;
  private sampler: GPUSampler;
  private bindGroup: GPUBindGroup;
  private cameraScratch = new Float32Array(CAMERA_UBO_BYTES / 4);

  static async create(canvas: HTMLCanvasElement): Promise<HeatmapTexture> {
    const gpu = await acquireGpu();
    if (gpu.status !== "ok") {
      throw new Error(`WebGPU unavailable: ${gpu.reason}`);
    }
    // Float32 textures need a feature on some platforms; we already requested
    // it via OPTIONAL_FEATURES in context.ts if available, but R32_FLOAT
    // *sampling* (not just storage) requires "float32-filterable" — also in
    // our optional list and confirmed present per smoke test on the 4080.
    if (!gpu.features.has("float32-filterable" as GPUFeatureName)) {
      throw new Error(
        "heatmapTexture: float32-filterable not available on this adapter; " +
        "use the RG8_UNORM fallback path (TODO)",
      );
    }
    resizeCanvas(canvas);
    const ctx = configureCanvas(canvas, gpu);
    if (!ctx) throw new Error("canvas.getContext('webgpu') returned null");
    return new HeatmapTexture(canvas, ctx, gpu);
  }

  private constructor(
    canvas: HTMLCanvasElement,
    ctx: GPUCanvasContext,
    gpu: GpuContextOK,
  ) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.gpu = gpu;
    const { device, preferredCanvasFormat } = gpu;

    const shader = device.createShaderModule({
      code: shaderSrc,
      label: "heatmapTexture.wgsl",
    });

    const bindGroupLayout = device.createBindGroupLayout({
      label: "heatmapTexture.bgl",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float", viewDimension: "2d" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    this.pipeline = device.createRenderPipeline({
      label: "heatmapTexture.pipeline",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout],
      }),
      vertex: { module: shader, entryPoint: "vs" },
      fragment: {
        module: shader,
        entryPoint: "fs",
        targets: [
          {
            format: preferredCanvasFormat,
            blend: {
              color: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-strip" },
    });

    this.cameraBuf = device.createBuffer({
      label: "heatmapTexture.camera",
      size: CAMERA_UBO_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // R32_FLOAT, single channel, signed. WebGPU spec guarantees this
    // format with TEXTURE_BINDING (sampling) + COPY_DST (CPU writes).
    this.texture = device.createTexture({
      label: "heatmapTexture.tex",
      size: { width: HEATMAP_COLUMN_CAPACITY, height: HEATMAP_PRICE_BUCKETS },
      format: "r32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // Linear filtering = bilinear interpolation = the smooth-gradient look.
    this.sampler = device.createSampler({
      label: "heatmapTexture.sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "repeat", // matches the ring-buffer rotation in shader
      addressModeV: "clamp-to-edge",
    });

    this.bindGroup = device.createBindGroup({
      label: "heatmapTexture.bg",
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuf } },
        { binding: 1, resource: this.texture.createView() },
        { binding: 2, resource: this.sampler },
      ],
    });
  }

  setCamera(c: HeatmapTextureCameraInputs): void {
    const s = this.cameraScratch;
    s[0] = c.timeRange[0];
    s[1] = c.timeRange[1];
    s[2] = c.priceRange[0];
    s[3] = c.priceRange[1];
    s[4] = this.canvas.width;
    s[5] = this.canvas.height;
    s[6] = c.ringOffset;
    s[7] = HEATMAP_COLUMN_CAPACITY;
    s[8] = c.intensityPower ?? 2.0;
    s[9] = c.alphaFloor ?? 0.0;
    s[10] = c.alphaCeil ?? 1.0;
    s[11] = c.edgeFadePx ?? 60.0;
    s[12] = 0;
    s[13] = 0;
    this.gpu.device.queue.writeBuffer(
      this.cameraBuf,
      0,
      s.buffer,
      s.byteOffset,
      CAMERA_UBO_BYTES,
    );
  }

  /**
   * Write one column's price-bucket slice to the texture at the given ring
   * index. Day 2 will wire this to the depth persistence accumulator:
   * for each new DepthPayload, compute the per-price-bucket intensities,
   * sign by side, and write the resulting 512-float column.
   *
   * Day 1: placeholder API; not yet called from the live dashboard.
   *
   * @param columnIndex 0..HEATMAP_COLUMN_CAPACITY-1
   * @param priceColumn Float32Array of length HEATMAP_PRICE_BUCKETS.
   *                    Values: signed intensity (positive=bid, negative=ask).
   */
  writeColumn(columnIndex: number, priceColumn: Float32Array): void {
    if (priceColumn.length !== HEATMAP_PRICE_BUCKETS) {
      throw new Error(
        `priceColumn length ${priceColumn.length} != HEATMAP_PRICE_BUCKETS ` +
        `(${HEATMAP_PRICE_BUCKETS})`,
      );
    }
    if (columnIndex < 0 || columnIndex >= HEATMAP_COLUMN_CAPACITY) {
      throw new Error(
        `columnIndex ${columnIndex} out of range [0, ${HEATMAP_COLUMN_CAPACITY})`,
      );
    }
    // writeTexture: we're writing a 1-column-wide × HEATMAP_PRICE_BUCKETS-tall
    // strip into the texture at x=columnIndex, y=0..HEATMAP_PRICE_BUCKETS.
    this.gpu.device.queue.writeTexture(
      { texture: this.texture, origin: { x: columnIndex, y: 0 } },
      priceColumn.buffer,
      { bytesPerRow: 4, rowsPerImage: HEATMAP_PRICE_BUCKETS },
      { width: 1, height: HEATMAP_PRICE_BUCKETS },
    );
  }

  /**
   * Clear the entire texture to zero. Useful on hydration backfill replay or
   * symbol changes. Day 1 placeholder — Day 2 will call this on session
   * boundary changes.
   */
  clear(): void {
    const zeros = new Float32Array(HEATMAP_PRICE_BUCKETS * HEATMAP_COLUMN_CAPACITY);
    this.gpu.device.queue.writeTexture(
      { texture: this.texture, origin: { x: 0, y: 0 } },
      zeros.buffer,
      {
        bytesPerRow: HEATMAP_COLUMN_CAPACITY * 4,
        rowsPerImage: HEATMAP_PRICE_BUCKETS,
      },
      {
        width: HEATMAP_COLUMN_CAPACITY,
        height: HEATMAP_PRICE_BUCKETS,
      },
    );
  }

  render(): Promise<undefined> {
    const device = this.gpu.device;
    if (resizeCanvas(this.canvas)) {
      this.ctx.configure({
        device,
        format: this.gpu.preferredCanvasFormat,
        alphaMode: "premultiplied",
      });
    }
    const encoder = device.createCommandEncoder({ label: "heatmapTexture.encoder" });
    const pass = encoder.beginRenderPass({
      label: "heatmapTexture.pass",
      colorAttachments: [
        {
          view: this.ctx.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    // 4 vertices, 1 instance: fullscreen quad.
    pass.draw(4, 1, 0, 0);
    pass.end();
    device.queue.submit([encoder.finish()]);
    return device.queue.onSubmittedWorkDone();
  }

  destroy(): void {
    this.cameraBuf.destroy();
    this.texture.destroy();
  }

  diagnostics(): { vendor: string; architecture: string } {
    return {
      vendor: this.gpu.adapterInfo?.vendor ?? "(unknown)",
      architecture: this.gpu.adapterInfo?.architecture ?? "(unknown)",
    };
  }
}
