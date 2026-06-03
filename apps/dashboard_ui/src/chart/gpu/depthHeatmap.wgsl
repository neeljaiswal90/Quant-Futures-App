// Depth heatmap shader — instanced rendering of all visible depth cells.
//
// Architecture: one draw call per frame with N instances, where N = visible
// depth cells (currently capped at MAX_DEPTH_CELLS = 75_000 in the Canvas2D
// renderer). The vertex shader uses @builtin(vertex_index) over a unit quad
// (4 verts, triangle-strip) and @builtin(instance_index) to pull per-cell
// attributes from a storage buffer.
//
// Coordinate system:
//   - camera.time_range:  [start_seconds, end_seconds]  (UTC)
//   - camera.price_range: [top_price, bottom_price]      (top is higher number)
//   - WebGPU NDC: x ∈ [-1, +1] (left → right), y ∈ [-1, +1] (bottom → top)
//
// Color: bid (intensity, side=0) → green; ask (intensity, side=1) → red.
// Intensity is pre-quantized by the contrast normalizer on the CPU
// (eventually moved to a compute shader in Phase 4). Alpha = intensity
// directly. Premultiplied alpha output.

struct Camera {
  // [start, end] in same units as Instance.time_start
  time_range: vec2f,
  // [top_price, bottom_price] — top is HIGHER price (top of chart)
  price_range: vec2f,
  // [w, h] in physical pixels; used for sub-pixel rounding to avoid shimmer
  canvas_size: vec2f,
  // [r, g, b, a] for the bid (green) side
  bid_color: vec4f,
  // [r, g, b, a] for the ask (red) side
  ask_color: vec4f,
  // Intensity power curve — higher = more contrast (DEPTH_INTENSITY_POWER)
  intensity_power: f32,
  // Alpha floor (DEPTH_MIN_SHOWN_OPACITY) and ceiling (DEPTH_MAX_OPACITY)
  alpha_floor: f32,
  alpha_ceil: f32,
  _pad: f32,
};

struct Instance {
  // time start (same units as camera.time_range; usually seconds since epoch)
  time_start: f32,
  // duration of this cell along the time axis (positive)
  time_width: f32,
  // center of this cell on the price axis
  price_center: f32,
  // height of this cell on the price axis (usually MNQ tick = 0.25)
  price_height: f32,
  // 0..1, normalized intensity
  intensity: f32,
  // 0.0 = bid (green), 1.0 = ask (red). f32 keeps struct 24B = 6 × f32 aligned.
  side: f32,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) intensity: f32,
  @location(1) side: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  // Unit quad as triangle-strip:
  //   (0,0)  bottom-left
  //   (1,0)  bottom-right
  //   (0,1)  top-left
  //   (1,1)  top-right
  let quad = array<vec2f, 4>(
    vec2f(0.0, 0.0),
    vec2f(1.0, 0.0),
    vec2f(0.0, 1.0),
    vec2f(1.0, 1.0),
  );
  let unit = quad[vi];
  let inst = instances[ii];

  let time_span = max(camera.time_range.y - camera.time_range.x, 1e-6);
  let price_span = max(camera.price_range.x - camera.price_range.y, 1e-6);

  // World position of this vertex of the cell
  let world_time = inst.time_start + unit.x * inst.time_width;
  let world_price = (inst.price_center - inst.price_height * 0.5)
                    + unit.y * inst.price_height;

  // Normalize to [0, 1]
  let x_norm = (world_time - camera.time_range.x) / time_span;
  // For Y, NDC up is +1, and we want HIGHER prices toward NDC +1.
  // camera.price_range.x = top_price (higher), .y = bottom_price (lower).
  // So y_norm = (world_price - bottom) / (top - bottom).
  let y_norm = (world_price - camera.price_range.y) / price_span;

  // NDC: [-1, 1]
  let x_ndc = x_norm * 2.0 - 1.0;
  let y_ndc = y_norm * 2.0 - 1.0;

  var out: VOut;
  out.pos = vec4f(x_ndc, y_ndc, 0.0, 1.0);
  out.intensity = inst.intensity;
  out.side = inst.side;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  // Apply the intensity power curve. The Canvas2D path uses pow(I, 2.0) by
  // default (DEPTH_INTENSITY_POWER); shader replicates that. Bimodal mapping:
  // thin liquidity dims toward dark, walls saturate toward bright.
  let i = pow(clamp(in.intensity, 0.0, 1.0), camera.intensity_power);

  // Map intensity to alpha within [alpha_floor, alpha_ceil].
  let alpha = mix(camera.alpha_floor, camera.alpha_ceil, i);

  // Color picks: side=0 → bid (green), side=1 → ask (red).
  let color = mix(camera.bid_color, camera.ask_color, in.side);

  // Premultiplied alpha output (matches alphaMode='premultiplied' on the canvas
  // context). The bid/ask color's own alpha channel is treated as a tint, then
  // we multiply by the per-cell intensity alpha.
  let final_alpha = alpha * color.a;
  return vec4f(color.rgb * final_alpha, final_alpha);
}
