// Block geometry, following gnuradio-companion's GTK canvas (grc/gui/canvas/block.py
// and port.py) so that coordinates stored in .grc files look the same here.
'use strict';

export const GRID = 8;
const LABEL_SEPARATION = 3;
const BLOCK_LABEL_PADDING = 7;
const PORT_LABEL_PADDING = 2;
const PORT_BORDER_SEPARATION = 8;
export const PORT_SEPARATION = 32;
const PORT_MIN_WIDTH = 20;
export const PORT_HEIGHT = 16;
const TITLE_HEIGHT = 14;
const PARAM_HEIGHT = 12;
export const CONNECTOR_EXTENSION = 11;
export const ARROW_BASE = 10;
export const ARROW_HEIGHT = 13;

const FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, "DejaVu Sans", sans-serif';
export const FONTS = {
  title: `bold 11px ${FAMILY}`,
  paramKey: `bold 10px ${FAMILY}`,
  param: `10px ${FAMILY}`,
  port: `10px ${FAMILY}`,
};

const ctx = document.createElement('canvas').getContext('2d');
const cache = new Map();
export function textWidth(text, font) {
  const key = font + '\u0000' + text;
  let w = cache.get(key);
  if (w === undefined) {
    ctx.font = font;
    w = ctx.measureText(text).width;
    if (cache.size > 20000) cache.clear();
    cache.set(key, w);
  }
  return w;
}

export function alignToGrid(v) {
  return Math.round(v / GRID) * GRID;
}

export function dirVector(d) {
  switch (((d % 360) + 360) % 360) {
    case 0: return [1, 0];
    case 90: return [0, -1];
    case 180: return [-1, 0];
    default: return [0, 1];
  }
}

// Which params are drawn on the block surface, and how.
export function paramLines(block, opts) {
  return block.params.map(([name, value, valid, expr]) => {
    let shown = value;
    if (expr && opts.showExpr) shown = opts.showValue ? `${expr}=${value}` : expr;
    return { key: name + ': ', value: shown, bad: !valid };
  });
}

export function layoutBlock(block, opts = {}) {
  const lines = paramLines(block, opts);
  const titleW = textWidth(block.label, FONTS.title);
  let paramsW = 0;
  for (const line of lines) {
    paramsW = Math.max(paramsW, textWidth(line.key, FONTS.paramKey) + textWidth(line.value, FONTS.param));
  }
  const labelW = Math.max(titleW, paramsW);
  let labelH = TITLE_HEIGHT;
  if (lines.length) labelH += LABEL_SEPARATION + lines.length * PARAM_HEIGHT + (lines.length - 1) * LABEL_SEPARATION;

  const minForPorts = (ports) => ports.length
    ? 2 * PORT_BORDER_SEPARATION + ports.length * PORT_SEPARATION - PORT_HEIGHT : 0;
  let w = labelW + 2 * BLOCK_LABEL_PADDING;
  let h = Math.max(labelH + 2 * BLOCK_LABEL_PADDING, minForPorts(block.in), minForPorts(block.out));
  w = alignToGrid(w);
  h = alignToGrid(h);

  const rot = ((block.rot % 360) + 360) % 360;
  const vertical = rot === 90 || rot === 270;
  const ports = [];
  const sides = [['in', block.in, (rot + 180) % 360], ['out', block.out, rot]];
  for (const [dir, list, d] of sides) {
    if (!list.length) continue;
    let pw = PORT_MIN_WIDTH;
    for (const p of list) pw = Math.max(pw, textWidth(p.n, FONTS.port) + 2 * PORT_LABEL_PADDING);
    pw = Math.ceil(pw);
    let offset = (h - (list.length - 1) * PORT_SEPARATION - PORT_HEIGHT) / 2;
    for (const p of list) {
      let x, y, pwid, phei, cx, cy;
      if (d === 0) { x = w; y = offset; pwid = pw; phei = PORT_HEIGHT; cx = x + pw; cy = y + PORT_HEIGHT / 2; }
      else if (d === 180) { x = -pw; y = offset; pwid = pw; phei = PORT_HEIGHT; cx = x; cy = y + PORT_HEIGHT / 2; }
      else if (d === 90) { x = offset; y = -pw; pwid = PORT_HEIGHT; phei = pw; cx = x + PORT_HEIGHT / 2; cy = y; }
      else { x = offset; y = w; pwid = PORT_HEIGHT; phei = pw; cx = x + PORT_HEIGHT / 2; cy = y + pw; }
      ports.push({ dir, key: p.k, port: p, x, y, w: pwid, h: phei, cx, cy, d });
      offset += PORT_SEPARATION;
    }
  }
  return {
    w, h, rot, vertical,
    bw: vertical ? h : w,   // body size on screen
    bh: vertical ? w : h,
    labelH, lines, ports,
  };
}

export function portByKey(layout, dir, key) {
  return layout.ports.find((p) => p.dir === dir && p.key === key);
}

// Path of a connection between two connector points with their directions.
export function connectionPath(sx, sy, sd, kx, ky, kd) {
  const [ux, uy] = dirVector(sd);
  const [vx, vy] = dirVector(kd);
  const p1x = sx + ux * CONNECTOR_EXTENSION, p1y = sy + uy * CONNECTOR_EXTENSION;
  const p2x = kx + vx * (CONNECTOR_EXTENSION + ARROW_HEIGHT), p2y = ky + vy * (CONNECTOR_EXTENSION + ARROW_HEIGHT);
  const ax = kx + vx * ARROW_HEIGHT, ay = ky + vy * ARROW_HEIGHT;
  const dist = Math.hypot(p2x - p1x, p2y - p1y);
  const c = Math.max(24, Math.min(160, dist * 0.45));
  const d = `M${sx},${sy} L${p1x},${p1y} C${p1x + ux * c},${p1y + uy * c} ${p2x + vx * c},${p2y + vy * c} ${p2x},${p2y} L${ax},${ay}`;
  const px = -vy, py = vx;
  const arrow = `${kx},${ky} ${ax + px * ARROW_BASE / 2},${ay + py * ARROW_BASE / 2} ${ax - px * ARROW_BASE / 2},${ay - py * ARROW_BASE / 2}`;
  return { d, arrow };
}
