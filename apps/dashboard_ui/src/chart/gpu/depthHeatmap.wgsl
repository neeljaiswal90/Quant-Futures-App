// Depth heatmap shader — instanced rendering of all visible depth cells +
// single-pass "fake bloom" halo on bright walls.
//
// Architecture: one draw call per frame with N instances, where N = visible
// depth cells (currently capped at MAX_DEPTH_CELLS = 75_000 in the Canvas2D
// renderer). The vertex shader uses @builtin(vertex_index) over a unit quad
// (4 verts, triangle-strip) and @builtin(instance_index) to pull per-cell
// attributes from a storage buffer.
//
// Bloom (RA-115 Phase 2): when a cell's intensity exceeds bloom_threshold,
// the vertex shader EXPANDS the quad in screen space by up to bloom_radius_px
// pixels in each direction. The fragment shader computes the distance from
// the fragment to the cell's INTERIOR rect (the unexpanded original) and
// applies a quadratic falloff outside that rect — producing a soft glowing
// halo around bright walls. This is single-pass — no intermediate textures
// or compositing required. Trade-off vs true multipass Gaussian bloom:
// halo overlap between adjacent bright cells blends via standard alpha
// (slightly more muted than additive) but the visual is still strong.
//
// Coordinate system:
//   - camera.time_range:  [start_seconds, end_seconds]  (UTC)
//   - camera.price_range: [top_price, bottom_price]      (top is higher number)
//   - WebGPU NDC: x ∈ [-1, +1] (left → right), y ∈ [-1, +1] (bottom → top)
//   - Fragment @builtin(position): pixel coords (x rightward, y downward)
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
  // 8 bytes padding here (vec4 alignment for bid_color)
  _pad0: vec2f,
  // [r, g, b, a] for the bid (green) side
  bid_color: vec4f,
  // [r, g, b, a] for the ask (red) side
  ask_color: vec4f,
  // Intensity power curve — higher = more contrast (DEPTH_INTENSITY_POWER)
  intensity_power: f32,
  // Alpha floor (DEPTH_MIN_SHOWN_OPACITY) and ceiling (DEPTH_MAX_OPACITY)
  alpha_floor: f32,
  alpha_ceil: f32,
  _pad1: f32,
  // RA-115 Phase 2: bloom params
  // Cells with intensity > bloom_threshold get a halo. Cells below: no bloom.
  bloom_threshold: f32,
  // Max halo radius in pixels (scales linearly with how far above threshold).
  bloom_radius_px: f32,
  _pad2: vec2f,
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
  // Cell's INTERIOR rect in pixel coords (left, top, right, bottom).
  // Fragment shader uses this + its own pixel pos to compute halo falloff.
  @location(2) inner_min_px: vec2f,
  @location(3) inner_max_px: vec2f,
  // Per-cell bloom radius in pixels (0 if cell isn't bright enough to bloom).
  @location(4) bloom_px: f32,
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

  // Cell INTERIOR in world coords (the un-expanded rect)
  let interior_time_start = inst.time_start;
  let interior_time_end = inst.time_start + inst.time_width;
  let interior_price_top = inst.price_center + inst.price_height * 0.5;
  let interior_price_bot = inst.price_center - inst.price_height * 0.5;

  // World units per pixel — for converting bloom_radius_px to world coords.
  let world_time_per_px = time_span / camera.canvas_size.x;
  let world_price_per_px = price_span / camera.canvas_size.y;

  // Bloom expansion: cells above bloom_threshold expand into a halo.
  // Cells well above threshold expand to the full bloom_radius_px.
  var bloom_px = 0.0;
  if (inst.intensity > camera.bloom_threshold && camera.bloom_radius_px > 0.0) {
    let f = clamp(
      (inst.intensity - camera.bloom_threshold) / max(1.0 - camera.bloom_threshold, 1e-6),
      0.0,
      1.0,
    );
    bloom_px = camera.bloom_radius_px * f;
  }
  let bloom_world_x = bloom_px * world_time_per_px;
  let bloom_world_y = bloom_px * world_price_per_px;

  // Expanded quad world position
  let world_time = (interior_time_start - bloom_world_x) +
                   unit.x * (inst.time_width + 2.0 * bloom_world_x);
  let world_price = (interior_price_bot - bloom_world_y) +
                    unit.y * (inst.price_height + 2.0 * bloom_world_y);

  // To NDC (LC + WebGPU agree: higher price → higher NDC Y → top of canvas)
  let x_norm = (world_time - camera.time_range.x) / time_span;
  let y_norm = (world_price - camera.price_range.y) / price_span;
  let x_ndc = x_norm * 2.0 - 1.0;
  let y_ndc = y_norm * 2.0 - 1.0;

  // Pre-compute the INTERIOR rect in pixel coords for the fragment shader.
  // Pixel coords: x rightward, y DOWNWARD (so price-top → low pixel y).
  let inner_x_min_px = (interior_time_start - camera.time_range.x) / time_span * camera.canvas_size.x;
  let inner_x_max_px = (interior_time_end - camera.time_range.x) / time_span * camera.canvas_size.x;
  // Y flip: top-price maps to pixel y = 0
  let inner_y_min_px = (1.0 - (interior_price_top - camera.price_range.y) / price_span) * camera.canvas_size.y;
  let inner_y_max_px = (1.0 - (interior_price_bot - camera.price_range.y) / price_span) * camera.canvas_size.y;

  var out: VOut;
  out.pos = vec4f(x_ndc, y_ndc, 0.0, 1.0);
  out.intensity = inst.intensity;
  out.side = inst.side;
  out.inner_min_px = vec2f(inner_x_min_px, inner_y_min_px);
  out.inner_max_px = vec2f(inner_x_max_px, inner_y_max_px);
  out.bloom_px = bloom_px;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  // Apply the intensity power curve. The Canvas2D path uses pow(I, 2.0) by
  // default (DEPTH_INTENSITY_POWER); shader replicates that. Bimodal mapping:
  // thin liquidity dims toward dark, walls saturate toward bright.
  let i = pow(clamp(in.intensity, 0.0, 1.0), camera.intensity_power);

  // Inside-cell alpha within [alpha_floor, alpha_ceil].
  let inside_alpha = mix(camera.alpha_floor, camera.alpha_ceil, i);

  // Color picks: side=0 → bid (green), side=1 → ask (red).
  let color = mix(camera.bid_color, camera.ask_color, in.side);

  // Distance from this fragment to the cell's INTERIOR rect, in pixels.
  // px_x increases rightward; px_y increases downward.
  let px = in.pos.xy;
  let dist_x = max(max(in.inner_min_px.x - px.x, px.x - in.inner_max_px.x), 0.0);
  let dist_y = max(max(in.inner_min_px.y - px.y, px.y - in.inner_max_px.y), 0.0);
  let dist = sqrt(dist_x * dist_x + dist_y * dist_y);

  // Default: full inside-cell alpha. Outside the interior: apply halo falloff.
  var alpha = inside_alpha;
  if (in.bloom_px > 0.0 && dist > 0.0) {
    // Quadratic falloff from cell edge (dist=0) to halo edge (dist=bloom_px).
    let halo = max(1.0 - dist / in.bloom_px, 0.0);
    alpha = inside_alpha * halo * halo;
  }

  // Premultiplied alpha output (matches alphaMode='premultiplied' on the
  // canvas context). color.a is treated as a tint that combines with the
  // intensity-derived alpha.
  let final_alpha = alpha * color.a;
  return vec4f(color.rgb * final_alpha, final_alpha);
}
