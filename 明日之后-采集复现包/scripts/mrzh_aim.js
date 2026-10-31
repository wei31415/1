#!/usr/bin/env node
// mrzh_aim.js - 场景节点解析 + OBB 准心射线 + 瞄准判定
// 节点结构（实测，marker = 0e 01 22 00 00 00）
//   marker+0  : 6 字节标记
//   marker+6  : u32 id
//   marker+32 : float4 位置 (x,y,z,w=1)
//   marker+56 : 3x3 旋转（行主序，行 = 局部轴在世界里的方向），每行后补 1 个 float
//   marker+308: float9  = max.xyz, min.xyz, 半尺寸.xyz
// 包围盒 = 模型 local AABB，原样不动（已用 0x7fd4 ↔ 0C3BE6A9D2FC3BDC 逐位核对）
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const core = require('./mrzh_core.js');

const DUMP_PATH = 'D:/workspace2/mrzh-pkgs/last_scene_dump.bin';
// 偏移都是相对 base（= marker 偏移 − 32）算的
const ROT_OFF = 88, BOX_OFF = 340;

function dumpScene(regionIdx) {
  if (!core.adbRoot()) return null;
  const s = core.loadSession();
  const regions = core.loadRegions();
  const r = regions.find(x => Number(x.idx) === Number(regionIdx != null ? regionIdx : s.region_idx));
  if (!r) return null;
  const skip = Math.floor(Number(r.start) / core.BLOCK);
  const cnt = Math.ceil(Number(r.size) / core.BLOCK);
  const b = execFileSync(core.ADB, ['-s', core.DEV, 'exec-out',
    `dd if=/proc/${core.getPid()}/mem bs=${core.BLOCK} skip=${skip} count=${cnt}`],
    { maxBuffer: 240 * 1024 * 1024, encoding: 'buffer', timeout: 120000 });
  try { fs.writeFileSync(DUMP_PATH, b); } catch (e) {}
  return b;
}

// 解析一个 marker 家族
function parseFamily(buf, b1, b2) {
  const PAT = Buffer.from([0x0e, b1, b2, 0, 0, 0]);
  const out = [];
  let i = -1;
  while ((i = buf.indexOf(PAT, i + 1)) !== -1) {
    if (i + 48 > buf.length) continue;
    const pos = i + 32;
    if (buf.readFloatLE(pos + 12) !== 1) continue;
    const x = buf.readFloatLE(pos), y = buf.readFloatLE(pos + 4), z = buf.readFloatLE(pos + 8);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (Math.abs(x) < 100 || Math.abs(z) < 100) continue;
    const base = i - 32;
    if (base + BOX_OFF + 36 > buf.length) continue;
    const R = [];
    for (let r = 0; r < 3; r++) {
      R.push([0, 1, 2].map(c => buf.readFloatLE(base + ROT_OFF + r * 16 + c * 4)));
    }
    const mx = [0, 1, 2].map(k => buf.readFloatLE(base + BOX_OFF + k * 4));
    const mn = [0, 1, 2].map(k => buf.readFloatLE(base + BOX_OFF + 12 + k * 4));
    out.push({
      mo: i, id: buf.readUInt32LE(i + 6), p: [x, y, z], R, mx, mn,
      sx: mx[0] - mn[0], sy: mx[1] - mn[1], sz: mx[2] - mn[2],
      fp: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]].map(v => +v.toFixed(2)).join('/'),
    });
  }
  return out;
}

// 全量节点（两个家族合并、按 id 去重）
function parseNodes(buf) {
  const all = [...parseFamily(buf, 0x01, 0x22), ...parseFamily(buf, 0x00, 0x22)];
  const m = new Map();
  for (const n of all) if (!m.has(n.id)) m.set(n.id, n);
  return [...m.values()];
}

function rotOk(R) {
  for (const v of R) { const n = Math.hypot(...v); if (!Number.isFinite(n) || Math.abs(n - 1) > 0.03) return false; }
  for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
    const d = R[a][0] * R[b][0] + R[a][1] * R[b][1] + R[a][2] * R[b][2];
    if (Math.abs(d) > 0.03) return false;
  }
  return true;
}
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const w2l = (R, v) => [
  R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
  R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
  R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
];

// 射线 vs 节点 OBB；返回 t（单位：0.1m）或 null
function rayHit(node, O, D) {
  const R = rotOk(node.R) ? node.R : I3;
  const ol = w2l(R, [O[0] - node.p[0], O[1] - node.p[1], O[2] - node.p[2]]);
  const dl = w2l(R, D);
  let tmin = 0, tmax = Infinity;
  for (let k = 0; k < 3; k++) {
    const lo = node.mn[k], hi = node.mx[k];
    if (Math.abs(dl[k]) < 1e-3) {
      if (ol[k] < lo || ol[k] > hi) return null;
      continue;
    }
    let t1 = (lo - ol[k]) / dl[k], t2 = (hi - ol[k]) / dl[k];
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin;
}

// 过滤出"可能是可交互物体"的节点：去天空盒、去地形块、去玩家自己
// 玩家自身渲染节点 —— 用"相机节点"当锚点（100% 可靠）：
// 相机节点的包围盒是 200000 的无限盒，位置和相机矩阵位置完全重合（实测距离 0.0）
// 玩家节点 = 离锚点 34~62 单位、人形三围（实测 前 21.5 / 右 3.0 / 上 −39.4，合计 45）
function playerNodeId(nodes, pc) {
  let camNode = null, bd = 1e9;
  for (const n of nodes) {
    if (n.sy < 100000) continue;
    const d = Math.hypot(n.p[0] - pc.cx, n.p[1] - pc.cy, n.p[2] - pc.cz);
    if (d < bd) { bd = d; camNode = n; }
  }
  const anchor = (camNode && bd < 2) ? camNode.p : [pc.cx, pc.cy, pc.cz];
  let best = null, score = 1e9;
  for (const n of nodes) {
    if (n.sy >= 100000) continue;
    if (!(n.sy > 14 && n.sy < 23)) continue;
    if (!(n.sx > 5 && n.sx < 22)) continue;
    if (!(n.sz > 5 && n.sz < 18)) continue;
    const d = Math.hypot(n.p[0] - anchor[0], n.p[1] - anchor[1], n.p[2] - anchor[2]);
    if (d < 32 || d > 64) continue;
    if (n.p[1] > anchor[1] - 10) continue;          // 玩家一定在相机下方
    const s = Math.abs(d - 45);
    if (s < score) { score = s; best = n; }
  }
  if (best) return best.id;
  // 退路：按"相机水平前方 32 单位"预测点找最近的
  const px = pc.px, pz = pc.pz;
  let b2 = null, bd2 = 1e9;
  for (const n of nodes) {
    if (n.sy >= 100000 || !(n.sy > 8 && n.sy < 30)) continue;
    if (!(n.sx > 1 && n.sz > 1 && n.sx < 25 && n.sz < 25)) continue;
    const d = Math.hypot(n.p[0] - px, n.p[2] - pz);
    if (d < bd2) { bd2 = d; b2 = n; }
  }
  return b2 && bd2 < 40 ? b2.id : null;
}

// 某个点是否落在节点 OBB 内（margin 外扩，单位 0.1m）
function pointInOBB(node, P, margin = 0) {
  const R = rotOk(node.R) ? node.R : I3;
  const l = w2l(R, [P[0] - node.p[0], P[1] - node.p[1], P[2] - node.p[2]]);
  for (let k = 0; k < 3; k++) {
    if (l[k] < node.mn[k] - margin || l[k] > node.mx[k] + margin) return false;
  }
  return true;
}

// 所有"人形候选"（相机斜后方 4.5 米、人形三围）。正常只有一个，全排除最稳
function playerCandidates(nodes, pc) {
  const out = [];
  let camNode = null, bd = 1e9;
  for (const n of nodes) {
    if (n.sy < 100000) continue;
    const d = Math.hypot(n.p[0] - pc.cx, n.p[1] - pc.cy, n.p[2] - pc.cz);
    if (d < bd) { bd = d; camNode = n; }
  }
  const anchor = (camNode && bd < 2) ? camNode.p : [pc.cx, pc.cy, pc.cz];
  for (const n of nodes) {
    if (n.sy >= 100000) continue;
    if (!(n.sy > 13 && n.sy < 27)) continue;
    if (!(n.sx > 4 && n.sx < 26)) continue;
    if (!(n.sz > 4 && n.sz < 26)) continue;
    const d = Math.hypot(n.p[0] - anchor[0], n.p[1] - anchor[1], n.p[2] - anchor[2]);
    if (d < 32 || d > 66) continue;
    out.push({ n, d });
  }
  out.sort((a, b) => Math.abs(a.d - 45) - Math.abs(b.d - 45));
  // 取最像的那个（以及离锚点距离与之相差 <3 的，一般是同一物体的 LOD 兄弟）
  if (!out.length) return [];
  const keep = [out[0]];
  for (let i = 1; i < out.length; i++) if (Math.abs(out[i].d - out[0].d) < 3) keep.push(out[i]);
  return keep.map(o => o.n.id);
}

function filterScenery(nodes, pc) {
  const bad = new Set(playerCandidates(nodes, pc));
  const pid = playerNodeId(nodes, pc);
  if (pid !== null) bad.add(pid);
  return nodes.filter(n => {
    if (!(n.sx > 0 && n.sy > 0 && n.sz > 0)) return false;
    if (n.sy >= 100000) return false;                    // 相机 / 天空盒
    if (n.sx > 200 && n.sz > 200) return false;          // 地形块（64m 网格）
    if (n.sy > 300) return false;                        // 太高
    if (bad.has(n.id)) return false;                     // 玩家自己
    return true;
  });
}

// 准心最近命中（已过滤），返回 { node, dist }
function crosshairHit(nodes, pc, opts = {}) {
  const O = [pc.cx, pc.cy, pc.cz];
  const L = Math.hypot(pc.fx, pc.fy, pc.fz) || 1;
  const D = [pc.fx / L, pc.fy / L, pc.fz / L];
  const list = filterScenery(nodes, pc);
  const hits = [];
  for (const n of list) {
    const t = rayHit(n, O, D);
    if (t === null || t <= 1) continue;
    hits.push({ node: n, dist: t });
  }
  hits.sort((a, b) => a.dist - b.dist);
  return { hits, O, D };
}

// 对单个目标：射线是否穿过它，穿过点距目标原点多少
function aimTrace(node, pc) {
  const O = [pc.cx, pc.cy, pc.cz];
  const L = Math.hypot(pc.fx, pc.fy, pc.fz) || 1;
  const D = [pc.fx / L, pc.fy / L, pc.fz / L];
  const t = rayHit(node, O, D);
  const dc = Math.hypot(node.p[0] - O[0], node.p[1] - O[1], node.p[2] - O[2]);
  return { hit: t !== null && t > 1, t, centerDist: dc };
}

// 形状签名：用长宽高比例，抵消 LOD 切换带来的整体缩放差异
// 石头：远 LOD 36.13/17.70/27.01，近 LOD 47.94/24.54/36.38 → 归一化后都在 (1.95~2.04, 1, 1.48~1.53)
function shapeSig(n) {
  if (!(n.sy > 0) || !Number.isFinite(n.sy)) return null;
  return [n.sx / n.sy, 1, n.sz / n.sy];
}
function sameShape(n, ref, tol = 0.12) {
  const s = shapeSig(n);
  if (!s) return false;
  return Math.abs(s[0] - ref[0]) <= ref[0] * tol && Math.abs(s[2] - ref[2]) <= ref[2] * tol;
}

// 点到 OBB 的距离（点在盒内返回 0），单位 0.1m
// k < 1 时按中心缩放盒子：用来抵消"高亮时包围盒被放大"造成的假象
function distPointToOBB(node, P, k = 1) {
  const R = rotOk(node.R) ? node.R : I3;
  const l = w2l(R, [P[0] - node.p[0], P[1] - node.p[1], P[2] - node.p[2]]);
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const lo = node.mn[i] * k, hi = node.mx[i] * k;
    const d = Math.max(lo - l[i], 0, l[i] - hi);
    s += d * d;
  }
  return Math.sqrt(s);
}

module.exports = {
  DUMP_PATH, dumpScene, parseNodes, parseFamily, filterScenery, playerNodeId, playerCandidates,
  rayHit, crosshairHit, aimTrace, rotOk, shapeSig, sameShape, pointInOBB, distPointToOBB,
};
