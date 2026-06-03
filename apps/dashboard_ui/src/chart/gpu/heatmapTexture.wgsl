// Bookmap-parity heatmap: fullscreen-quad shader sampling a 2D persistence
// texture per fragment. Continuous gradient via hardware bilinear filtering.
// Replaces the per-cell instanced rendering once Path A Week 1 integration
// lands.
//
// Texture encoding (R32_FLOAT, single channel, signed):
//   texel = 0.0   → no liquidity at this (column, price)
//   texel > 0     → bid-side liquidity, magnitude = intensity (0..1)
//   texel < 0     → ask-side liquidity, magnitude = |intensity| (0..1)
//
// Texture coordinate convention:
//   u axis = time      (0 = oldest visible, 1 = newest visible)
//   v axis = price     (0 = bottom of visible band, 1 = top)
// The texture is a ring buffer in column space; `ring_offset` uniform
// rotates the lookup so the newest column always lands at u=1.

struct Camera {
  // [start, end] seconds since epoch
  time_range: vec2f,
  // [top_price, bottom_price] (top is higher)
  price_range: vec2f,
  // [w, h] in physical pixels — used for pixel-perfect alignment
  canvas_size: vec2f,
  // Ring-buffer offset: which column index corresponds to the NEWEST data.
  // Used to rotate the texture lookup so newest is always at u=1.
  ring_offset: f32,
  // Total number of column slots in the ring buffer (e.g. 512).
  ring_capacity: f32,
  // Intensity power curve (replaces DEPTH_INTENSITY_POWER from old shader).
  // Higher = stronger contrast between thin and walls.
  intensity_power: f32,
  // Alpha floor + ceiling — output alpha range.
  alpha_floor: f32,
  alpha_ceil: f32,
  // Left-edge fade width in pixels (carried over from previous shader).
  edge_fade_px: f32,
  _pad: vec2f,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var heatmap_tex: texture_2d<f32>;
@group(0) @binding(2) var heatmap_sampler: sampler;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

// Fullscreen quad: 4 vertices, triangle-strip.
// (-1,-1) → bottom-left, (+1,-1) → bottom-right, (-1,+1) → top-left, (+1,+1) → top-right
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let positions = array<vec2f, 4>(
    vec2f(-1.0, -1.0),
    vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0),
    vec2f( 1.0,  1.0),
  );
  let p = positions[vi];
  var out: VOut;
  out.pos = vec4f(p, 0.0, 1.0);
  // UV: 0..1 across the screen.  u increases rightward (= newer time),
  //                              v increases upward (= higher price).
  out.uv = vec2f((p.x + 1.0) * 0.5, (p.y + 1.0) * 0.5);
  return out;
}

/**
 * Map normalized intensity [0,1] + side {bid=+, ask=-} to a Bookmap-style
 * palette. Side encoded as f32 sign of the raw texel.
 *
 * Bid (positive): deep navy → cyan → bright white-cyan at saturation
 * Ask (negative): deep purple → magenta → bright white-orange at saturation
 *
 * Both ramps hit pure black at intensity 0 so the chart background shows
 * through where liquidity is absent.
 */
fn palette(intensity: f32, is_ask: bool) -> vec3f {
  let i = clamp(intensity, 0.0, 1.0);
  // Smooth three-stop gradient: dark → mid → bright.
  if (is_ask) {
    // ask: deep red → orange → yellow
    let low = vec3f(0.10, 0.02, 0.02);   // very dark red
    let mid = vec3f(0.85, 0.20, 0.05);   // saturated red-orange
    let hi  = vec3f(1.00, 0.85, 0.30);   // bright orange-yellow
    if (i < 0.5) {
      return mix(low, mid, i * 2.0);
    } else {
      return mix(mid, hi, (i - 0.5) * 2.0);
    }
  } else {
    // bid: deep navy → teal-cyan → bright cyan-white
    let low = vec3f(0.02, 0.04, 0.12);   // very dark navy
    let mid = vec3f(0.05, 0.55, 0.65);   // saturated teal
    let hi  = vec3f(0.55, 0.95, 1.00);   // bright cyan-white
    if (i < 0.5) {
      return mix(low, mid, i * 2.0);
    } else {
      return mix(mid, hi, (i - 0.5) * 2.0);
    }
  }
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  // Rotate the u coordinate through the ring buffer so the newest column
  // sits at u=1 (right edge of screen).
  // ring_u = (in.uv.x * ring_capacity + ring_offset - ring_capacity) mod ring_capacity
  // Then divide by ring_capacity to get the texture UV.
  let total = camera.ring_capacity;
  let u_raw = in.uv.x * total + camera.ring_offset - total;
  // Modulo into [0, total)
  let u_mod = u_raw - floor(u_raw / total) * total;
  let tex_u = u_mod / total;
  // v: 0..1, no rotation (price axis is stable per frame)
  let tex_v = in.uv.y;

  // Sample with hardware bilinear filtering — this is what produces the
  // smooth continuous gradient that defines the Bookmap look.
  let texel = textureSample(heatmap_tex, heatmap_sampler, vec2f(tex_u, tex_v)).r;

  // Decode: sign = side, magnitude = intensity
  let intensity_raw = abs(texel);
  let is_ask = texel < 0.0;

  // Apply intensity power curve (bimodal — thin recedes, walls saturate)
  let intensity = pow(clamp(intensity_raw, 0.0, 1.0), camera.intensity_power);

  // Palette
  let color_rgb = palette(intensity, is_ask);

  // Alpha: scale by intensity within [floor, ceil].
  // No floor when intensity is literal 0 so background shows fully through.
  var alpha = 0.0;
  if (intensity_raw > 0.001) {
    alpha = mix(camera.alpha_floor, camera.alpha_ceil, intensity);
  }

  // Left-edge fade: cells with x < edge_fade_px alpha-attenuate toward 0
  // at the screen edge. Matches the existing visual treatment.
  let px_x = in.pos.x;
  let edge_fade = smoothstep(0.0, camera.edge_fade_px, px_x);
  alpha = alpha * edge_fade;

  // Premultiplied alpha output
  return vec4f(color_rgb * alpha, alpha);
}
