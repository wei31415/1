#!/usr/bin/env node
// mrzh_locate.js - 自愈定位（状态0）：重建 pid/maps → 找场景区域 → 走一步对比 → 相机矩阵 → session.json
// 只在启动、换图、或读取失效时跑一次。全程分块扫描，内存占用 < 200MB
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const core = require('./mrzh_core.js');
const { Input, VK } = require('./mrzh_input.js');

const ADB = core.ADB, DEV = core.DEV, TMP = core.TMP, PKGS = core.PKGS, BLOCK = core.BLOCK;
const cmdf = (s) => spawnSync('C:/Windows/System32/cmd.exe', ['/c', s], { stdio: 'ignore', timeout: 180000 });

function step(msg) { console.log('  ' + msg); }

// ---------- 1. maps → rw 区域 ----------
function rebuildRegions(pid) {
  const out = execFileSync(ADB, ['-s', DEV, 'shell', `cat /proc/${pid}/maps`], { encoding: 'latin1', maxBuffer: 64 * 1024 * 1024 });
  const rw = [];
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]+)-([0-9a-f]+)\s+rw/.exec(line);
    if (!m) continue;
    const s = parseInt(m[1], 16), e = parseInt(m[2], 16);
    const size = e - s;
    if (size >= 8 * 1024 * 1024) rw.push({ start: s, size, hex: m[1] });
  }
  rw.sort((a, b) => b.size - a.size);
  const regions = rw.map((r, i) => ({ idx: i, start: r.start, size: r.size, hex: r.hex }));
  fs.writeFileSync(path.join(PKGS, 'regions.json'), JSON.stringify(regions, null, 1));
  return regions;
}

// ---------- 2. 分块找场景区域（0e0122 最多）----------
function findSceneRegion(pid, regions, maxCheck = 60) {
  const PAT = Buffer.from('0e0122000000', 'hex');
  const tmpf = path.join(TMP, 'scan.bin');
  let best = null;
  const lim = Math.min(maxCheck, regions.length);
  for (let i = 0; i < lim; i++) {
    const r = regions[i];
    const cap = Math.min(r.size, 96 * 1024 * 1024);
    const skip = Math.floor(r.start / BLOCK);
    const cnt = Math.ceil(cap / BLOCK);
    let n = 0;
    try {
      const b = execFileSync(ADB, ['-s', DEV, 'exec-out', `dd if=/proc/${pid}/mem bs=${BLOCK} skip=${skip} count=${cnt}`],
        { maxBuffer: 240 * 1024 * 1024, encoding: 'buffer', timeout: 60000 });
      if (!b || b.length < 65536) continue;
      let pos = 0;
      while ((pos = b.indexOf(PAT, pos)) >= 0) { n++; pos += 6; }
    } catch (e) { continue; }
    if (n > 0) step(`#${i} 0x${r.hex} ${(r.size / 1048576).toFixed(0)}MB → marker ${n}`);
    if (!best || n > best.n) best = { idx: i, n, region: r };
    if (n > 300) { console.log("    命中，停止扫描"); break; }
  }
  try { fs.unlinkSync(tmpf); } catch (e) {}
  return best;
}

// ---------- 3. 区域内的 0e0122 节点 ----------
function collectNodes(buf) {
  const PAT = Buffer.from('0e0122000000', 'hex');
  const out = [];
  let i = -1;
  while ((i = buf.indexOf(PAT, i + 1)) !== -1) {
    const po = i + 32;
    if (po + 16 > buf.length) continue;
    if (buf.readFloatLE(po + 12) !== 1) continue;
    const x = buf.readFloatLE(po), y = buf.readFloatLE(po + 4), z = buf.readFloatLE(po + 8);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (Math.abs(x) < 100 || Math.abs(z) < 100) continue;
    const base = i - 32;
    let h = NaN, bbox = null;
    if (base + 372 < buf.length) {
      bbox = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(k => buf.readFloatLE(base + 340 + k * 4));
      h = bbox[1] - bbox[4];
    }
    out.push({ mo: i, base, id: buf.readUInt32LE(i + 6), x, y, z, h, bbox });
  }
  return out;
}

function dumpRegion(pid, region, outFile) {
  const skip = Math.floor(region.start / BLOCK);
  const cnt = Math.ceil(region.size / BLOCK);
  try {
    const b = execFileSync(ADB, ['-s', DEV, 'exec-out', `dd if=/proc/${pid}/mem bs=${BLOCK} skip=${skip} count=${cnt}`],
      { maxBuffer: 240 * 1024 * 1024, encoding: 'buffer', timeout: 90000 });
    return (b && b.length > 4096) ? b : null;
  } catch (e) { return null; }
}

// ---------- 4. 走一步对比找 相机/玩家 ----------
async function walkDiff(pid, region) {
  const A = path.join(TMP, 'locA.bin');
  const B = path.join(TMP, 'locB.bin');
  const bufA = dumpRegion(pid, region, A);
  if (!bufA) return null;
  const inp = new Input();
  if (!(await inp.refresh()).startsWith('OK')) { inp.stop(); return { err: 'no-hwnd' }; }
  await inp.focus();
  await inp.hold(VK.W, 2000);
  await new Promise(r => setTimeout(r, 500));
  inp.stop();
  const bufB = dumpRegion(pid, region, B);
  if (!bufB) return null;
  const na = collectNodes(bufA), nb = collectNodes(bufB);
  const mapA = new Map(); for (const o of na) mapA.set(o.mo, o);
  const movers = [];
  for (const o of nb) {
    const a = mapA.get(o.mo);
    if (!a) continue;
    const dx = o.x - a.x, dy = o.y - a.y, dz = o.z - a.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > 5) movers.push({ id: o.id, a, b: o, dx, dy, dz, d, mo: o.mo });
  }
  // 配对：相机候选 = 包围盒高度 >=100000（±100000 的"无限盒"节点）
  //       玩家候选 = 包围盒高度 10~30（人形尺寸）
  //       要求位移向量相同 + 几何吻合（竖直 10~40，水平 20~70）
  let pair = null;
  const camC = movers.filter(m => Number.isFinite(m.b.h) && m.b.h >= 100000);
  const plC  = movers.filter(m => Number.isFinite(m.b.h) && m.b.h >= 10 && m.b.h <= 30);
  for (const p of camC) {
    for (const q of plC) {
      const dd = Math.hypot(p.dx - q.dx, p.dy - q.dy, p.dz - q.dz);
      if (dd > 3.0) continue;
      const vdiff = p.b.y - q.b.y;
      const hz = Math.hypot(p.b.x - q.b.x, p.b.z - q.b.z);
      if (vdiff > 8 && vdiff < 45 && hz > 18 && hz < 70) { pair = { cam: p, pl: q }; break; }
    }
    if (pair) break;
  }
  // 兜底：老判据（位移相同 + 竖直 10~30 + 水平 20~60）
  if (!pair) {
    for (let i = 0; i < movers.length && !pair; i++) {
      for (let j = i + 1; j < movers.length && !pair; j++) {
        const p = movers[i], q = movers[j];
        const dd = Math.hypot(p.dx - q.dx, p.dy - q.dy, p.dz - q.dz);
        if (dd > 3.0) continue;
        const vdiff = Math.abs(p.b.y - q.b.y);
        const hz = Math.hypot(p.b.x - q.b.x, p.b.z - q.b.z);
        if (vdiff > 8 && vdiff < 45 && hz > 18 && hz < 70) pair = { cam: p.b.y >= q.b.y ? p : q, pl: p.b.y >= q.b.y ? q : p };
      }
    }
  }
  try { fs.unlinkSync(A); fs.unlinkSync(B); } catch (e) {}
  return { movers: movers.length, pair, nodeCount: na.length };
}

// ---------- 5. 局部扫相机矩阵 ----------
function findCamMatrix(buf, markerOff, expPos) {
  const lo = Math.max(0, markerOff - 0x100);
  const hi = Math.min(buf.length - 64, markerOff + 0x200);
  let best = null;
  for (let off = lo; off + 64 <= hi; off += 16) {
    const a = [0, 1, 2].map(k => buf.readFloatLE(off + k * 4));
    const c = [0, 1, 2].map(k => buf.readFloatLE(off + 16 + k * 4));
    const e = [0, 1, 2].map(k => buf.readFloatLE(off + 32 + k * 4));
    const g = [0, 1, 2, 3].map(k => buf.readFloatLE(off + 48 + k * 4));
    if (![...a, ...c, ...e, ...g].every(Number.isFinite)) continue;
    const na = Math.hypot(...a), nc = Math.hypot(...c), ne = Math.hypot(...e);
    if (Math.abs(na - 1) > 0.01 || Math.abs(nc - 1) > 0.01 || Math.abs(ne - 1) > 0.01) continue;
    if (Math.abs(a[0] * c[0] + a[1] * c[1] + a[2] * c[2]) > 0.02) continue;
    if (Math.abs(a[0] * e[0] + a[1] * e[1] + a[2] * e[2]) > 0.02) continue;
    if (Math.abs(c[0] * e[0] + c[1] * e[1] + c[2] * e[2]) > 0.02) continue;
    if (Math.abs(g[3] - 1) > 0.01) continue;
    if (Math.abs(g[0]) < 100 || Math.abs(g[0]) > 200000) continue;
    if (Math.abs(g[2]) < 100 || Math.abs(g[2]) > 200000) continue;
    if (g[1] < -500 || g[1] > 5000) continue;
    const dcam = expPos ? Math.hypot(g[0] - expPos.x, g[1] - expPos.y, g[2] - expPos.z) : 0;
    if (!best || dcam < best.dcam) best = { off, pos: g, fwd: e, dcam };
  }
  return best;
}

// ---------- 主流程 ----------
async function locate(opts = {}) {
  console.log('=== 状态0：自愈定位 ===');
  let pid = core.getPid();
  if (!pid) { console.log('  ✗ 游戏没开（pidof 返回空）'); return null; }
  step('pid = ' + pid);
  if (!core.adbRoot()) { console.log('  ✗ adb root 失败'); return null; }
  step('root ✓');
  const regions = rebuildRegions(pid);
  step(`regions.json 重建：${regions.length} 个 rw 区域（>=8MB）`);
  const scene = findSceneRegion(pid, regions);
  if (!scene) { console.log('  ✗ 没找到场景区域'); return null; }
  step(`场景区域 #${scene.idx}  marker ${scene.n}`);
  const region = scene.region;
  console.log('');
  console.log('=== 走一步对比（需要模拟器有焦点，会自动抢）===');
  const wd = await walkDiff(pid, region);
  if (!wd || wd.err) { console.log('  ✗ ' + (wd && wd.err ? wd.err : '转储失败')); return null; }
  step(`节点 ${wd.nodeCount} 个，位移>5 的 ${wd.movers} 个`);
  if (!wd.pair) { console.log('  ✗ 没找到 相机/玩家 配对（W 可能没进去）'); return null; }
  step(`配对：相机 0x${wd.pair.cam.id.toString(16)} 玩家 0x${wd.pair.pl.id.toString(16)}`);
  const buf = dumpRegion(pid, region, path.join(TMP, 'locC.bin'));
  if (!buf) return null;
  // 在 C 这次转储里重新定位相机节点（角色走完还有惯性，位置会变）
  const nodesC = collectNodes(buf);
  const camId = wd.pair.cam.id;
  let camNode = nodesC.find(n => n.id === camId);
  if (!camNode) {
    // id 变了：按"包围盒高度 >=100000 + 最接近 B 里相机位置"找
    const big = nodesC.filter(n => Number.isFinite(n.h) && n.h >= 100000);
    let bestD = 1e18;
    for (const n of big) {
      const d = Math.hypot(n.x - wd.pair.cam.b.x, n.y - wd.pair.cam.b.y, n.z - wd.pair.cam.b.z);
      if (d < bestD) { bestD = d; camNode = n; }
    }
  }
  if (!camNode) { console.log('  ✗ C 转储里找不到相机节点'); return null; }
  step(`C 里的相机节点 id=0x${camNode.id.toString(16)} pos (${camNode.x.toFixed(1)}, ${camNode.y.toFixed(1)}, ${camNode.z.toFixed(1)})`);
  const camPos = { x: camNode.x, y: camNode.y, z: camNode.z };
  const cm = findCamMatrix(buf, camNode.mo, camPos);
  if (!cm) { console.log('  ✗ 相机矩阵没找到'); return null; }
  step(`相机矩阵 @0x${cm.off.toString(16)}  pos (${cm.pos.map(v => v.toFixed(1)).join(', ')})`);
  const yaw = Math.atan2(cm.fwd[0], cm.fwd[2]) * 180 / Math.PI;
  const pitch = Math.asin(Math.max(-1, Math.min(1, cm.fwd[1]))) * 180 / Math.PI;
  step(`yaw ${yaw.toFixed(2)}  pitch ${pitch.toFixed(2)}`);
  const session = {
    pid,
    region_idx: scene.idx,
    region_start: String(region.start),
    region_size: String(region.size),
    camera_matrix_off: cm.off,
    player_node_mo: wd.pair.pl.mo,
    camera_node_id: camNode.id,
    camera_node_mo: camNode.mo,
    player_node_id: wd.pair.pl.id,
    yaw_at_locate: +yaw.toFixed(2),
    ts: new Date().toISOString()
  };
  fs.writeFileSync(path.join(PKGS, 'session.json'), JSON.stringify(session, null, 1));
  console.log('');
  console.log('  ✓ session.json 已写入');
  try { fs.unlinkSync(path.join(TMP, 'locC.bin')); } catch (e) {}
  return session;
}

if (require.main === module) {
  locate().catch(e => { console.error('定位异常: ' + e.message); process.exit(1); });
}
module.exports = { locate, collectNodes, rebuildRegions, findSceneRegion, findCamMatrix };
