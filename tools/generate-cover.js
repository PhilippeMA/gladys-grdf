// -----------------------------------------------------------------------------
// Generates `cover.png`, the 800x534 catalog cover required by the store.
//
// Run it with `node tools/generate-cover.js`. It writes a self-contained PNG
// with no dependency: shapes are rasterized by hand (supersampled polygon fill)
// and the file is encoded with the built-in `zlib`.
//
// The drawing: a night-blue background, the daily consumption bars the
// integration produces, and the gas flame they measure.
// -----------------------------------------------------------------------------

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const WIDTH = 800;
const HEIGHT = 534;
const SAMPLES = 3; // supersampling factor per axis (anti-aliasing)

// --- Colors ------------------------------------------------------------------
const BACKGROUND_TOP = [10, 26, 51]; // deep navy
const BACKGROUND_BOTTOM = [16, 52, 92]; // GRDF-ish blue
const BAR_TOP = [255, 189, 89];
const BAR_BOTTOM = [244, 124, 41];
const BAR_DIM = [255, 255, 255];
const FLAME_OUTER_TOP = [255, 176, 59];
const FLAME_OUTER_BOTTOM = [235, 87, 30];
const FLAME_INNER_TOP = [255, 244, 214];
const FLAME_INNER_BOTTOM = [255, 205, 110];

// --- Canvas ------------------------------------------------------------------
const pixels = new Float64Array(WIDTH * HEIGHT * 3);

const lerp = (a, b, t) => a + (b - a) * t;
const mixColor = (from, to, t) => [
  lerp(from[0], to[0], t),
  lerp(from[1], to[1], t),
  lerp(from[2], to[2], t),
];

function blend(x, y, color, alpha) {
  if (alpha <= 0 || x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) {
    return;
  }
  const offset = (y * WIDTH + x) * 3;
  for (let channel = 0; channel < 3; channel += 1) {
    pixels[offset + channel] = lerp(pixels[offset + channel], color[channel], alpha);
  }
}

// --- Geometry ----------------------------------------------------------------

/** Sample a cubic Bézier into points. */
function bezier(p0, p1, p2, p3, steps = 24) {
  const points = [];
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const u = 1 - t;
    points.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return points;
}

/** Is the point inside the polygon? (even-odd ray casting) */
function isInside(polygon, x, y) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Fill a polygon with a vertical gradient, anti-aliased by supersampling.
 * @param {Array<[number, number]>} polygon
 * @param {(t: number) => number[]} colorAt `t` goes from 0 (top) to 1 (bottom)
 * @param {number} opacity
 */
function fillPolygon(polygon, colorAt, opacity = 1) {
  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const maxX = Math.min(WIDTH - 1, Math.ceil(Math.max(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(HEIGHT - 1, Math.ceil(Math.max(...ys)));
  const height = Math.max(1, Math.max(...ys) - Math.min(...ys));
  const top = Math.min(...ys);

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = x + (sx + 0.5) / SAMPLES;
          const py = y + (sy + 0.5) / SAMPLES;
          if (isInside(polygon, px, py)) {
            hits += 1;
          }
        }
      }
      if (hits > 0) {
        const coverage = hits / (SAMPLES * SAMPLES);
        blend(x, y, colorAt((y + 0.5 - top) / height), coverage * opacity);
      }
    }
  }
}

/** Polygon of a rounded rectangle. */
function roundedRect(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  const corner = (cx, cy, from) => {
    const points = [];
    for (let index = 0; index <= 8; index += 1) {
      const angle = from + (index / 8) * (Math.PI / 2);
      points.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
    }
    return points;
  };
  return [
    ...corner(x + r, y + r, Math.PI),
    ...corner(x + width - r, y + r, -Math.PI / 2),
    ...corner(x + width - r, y + height - r, 0),
    ...corner(x + r, y + height - r, Math.PI / 2),
  ];
}

/** Polygon of a flame, in a box of `size` height anchored at (x, y) = base center. */
function flame(x, y, size) {
  const w = size * 0.68;
  const point = (px, py) => [x + px * w, y - size + py * size];
  return [
    point(0, 0),
    ...bezier(point(0, 0), point(0.42, 0.28), point(0.68, 0.42), point(0.62, 0.64)),
    ...bezier(point(0.62, 0.64), point(0.58, 0.88), point(0.34, 1), point(0, 1)),
    ...bezier(point(0, 1), point(-0.34, 1), point(-0.58, 0.88), point(-0.62, 0.64)),
    ...bezier(point(-0.62, 0.64), point(-0.68, 0.42), point(-0.42, 0.28), point(0, 0)),
  ];
}

// --- Drawing -----------------------------------------------------------------

// Background: vertical gradient with a soft glow behind the flame.
for (let y = 0; y < HEIGHT; y += 1) {
  const base = mixColor(BACKGROUND_TOP, BACKGROUND_BOTTOM, y / (HEIGHT - 1));
  for (let x = 0; x < WIDTH; x += 1) {
    const dx = (x - 235) / 330;
    const dy = (y - 270) / 330;
    const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy)) ** 2;
    const offset = (y * WIDTH + x) * 3;
    pixels[offset] = base[0] + glow * 42;
    pixels[offset + 1] = base[1] + glow * 26;
    pixels[offset + 2] = base[2] + glow * 4;
  }
}

// The flame.
fillPolygon(flame(235, 420, 280), (t) => mixColor(FLAME_OUTER_TOP, FLAME_OUTER_BOTTOM, t));
fillPolygon(flame(235, 420, 148), (t) => mixColor(FLAME_INNER_TOP, FLAME_INNER_BOTTOM, t));

// The daily consumption bars, one per day of a week.
const BAR_HEIGHTS = [0.34, 0.52, 0.44, 0.72, 0.63, 0.88, 0.58];
const barWidth = 34;
const barGap = 18;
const chartLeft = 440;
const chartBottom = 420;
const chartHeight = 240;

BAR_HEIGHTS.forEach((ratio, index) => {
  const x = chartLeft + index * (barWidth + barGap);
  const height = chartHeight * ratio;
  // Ghost of the full-scale bar, to read as a chart rather than a skyline.
  fillPolygon(
    roundedRect(x, chartBottom - chartHeight, barWidth, chartHeight, barWidth / 2),
    () => BAR_DIM,
    0.07,
  );
  fillPolygon(roundedRect(x, chartBottom - height, barWidth, height, barWidth / 2), (t) =>
    mixColor(BAR_TOP, BAR_BOTTOM, t),
  );
});

// Baseline of the chart.
fillPolygon(
  roundedRect(chartLeft, chartBottom + 20, BAR_HEIGHTS.length * (barWidth + barGap) - barGap, 6, 3),
  () => BAR_DIM,
  0.28,
);

// --- PNG encoding ------------------------------------------------------------

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

// Raw scanlines, each prefixed with its filter type (0 = none).
const raw = Buffer.alloc(HEIGHT * (WIDTH * 3 + 1));
for (let y = 0; y < HEIGHT; y += 1) {
  const rowStart = y * (WIDTH * 3 + 1);
  raw[rowStart] = 0;
  for (let x = 0; x < WIDTH * 3; x += 1) {
    raw[rowStart + 1 + x] = Math.max(0, Math.min(255, Math.round(pixels[y * WIDTH * 3 + x])));
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(WIDTH, 0);
ihdr.writeUInt32BE(HEIGHT, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type: truecolor RGB
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const output = new URL('../cover.png', import.meta.url);
writeFileSync(output, png);
console.log(`cover.png written: ${WIDTH}x${HEIGHT}, ${(png.length / 1024).toFixed(1)} KB`);
