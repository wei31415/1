#!/usr/bin/env node
// camfind6.js - 按文档配方 + "位移簇"定 θ
//   ① 背靠背 dump A → 走一步 → dump B
//   ② 所有节点里按位移向量分组，取最大簇 → Δ*（文档：玩家位移在 207 份副本里一致）
//   ③ θ = atan2(Δ*.x, Δ*.z)
//   ④ 扫正交归一 3x3：某行水平方位角与 θ 差 <3°，base+48 是 w=1.0 位置，位置距该簇中心 5~300
//   ⑤ 复活检查：B 同一偏移的位置位移必须等于 Δ*（文档：逐位一致）
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const core = require('./mrzh_core.js');
const { Input, VK } = require('./mrzh_input.js');
const aim = require('./mrzh_aim.js');
const L = require('./mrzh_locate.js');

const BLOCK = core.BLOCK, PKGS = core.PKGS;
const AZ_TOL = 3.0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function dumpRegion(pid, r) {
  const skip = Math.floor(Number(r.start) / BLOCK);
  const cnt = Math.ceil(Number(r.size) / BLOCK);
  return execFileSync(core.ADB, ['-s', core.DEV, 'exec-out',
    `dd if=/proc/${pid}/mem bs=${BLOCK} skip=${skip} count=${cnt}`],
    { maxBuffer: 240 * 1024 * 1024, encoding: 'buffer', timeout: 120000 });
}
const azim = (x, z) => Math.atan2(x, z) * 180 / Math.PI;
const norm180 = a => { while (a > 180) a -= 360; while (a < -180) a += 360; return a; };
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

(async () => {
  const pid = core.getPid();
  if (!pid) return console.log('没找到游戏进程');
  if (!core.adbRoot()) return console.log('adb root 失败');
  const regions = core.loadRegions() || L.rebuildRegions(pid);
  const scene = L.findSceneRegion(pid, regions);
  if (!scene) return console.log('没找到场景区域');
  const R = scene.region;
  console.log(`pid ${pid}  场景区域 #${scene.idx} 0x${R.hex} ${(R.size / 1048576).toFixed(0)}MB`);

  const bufA = dumpRegion(pid, R);
  const nA = aim.parseNodes(bufA);
  const inp = new Input();
  if (!(await inp.start())) return console.log('输入助手启动失败');
  console.log('抢焦点:', await inp.focus());
  await sleep(250);
  await inp.hold(VK.W, 800);
  const bufB = dumpRegion(pid, R);      // 背靠背
  inp.stop();
  const nB = aim.parseNodes(bufB);
  console.log(`A 节点 ${nA.length}  B 节点 ${nB.length}`);

  // ② 位移簇
  const mapA = new Map(nA.map(n => [n.id, n]));
  const groups = new Map();
  for (const b of nB) {
    const a = mapA.get(b.id);
    if (!a) continue;
    const dp = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]];
    const d = Math.hypot(...dp);
    if (d < 12) continue;
    const k = dp.map(v => Math.round(v)).join(',');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ a, b, dp, d });
  }
  const top = [...groups.entries()].sort((x, y) => y[1].length - x[1].length).slice(0, 5);
  console.log(`\n位移分组（按数量）：`);
  for (const [k, v] of top) console.log(`  Δ=${k}  ×${v.length}  |Δ|=${v[0].d.toFixed(1)}`);
  if (!top.length) return console.log('✗ 没有位移节点（角色没走？）');
  const [dkey, dgroup] = top[0];
  const D = dgroup[0].dp;
  const theta = azim(D[0], D[2]);
  const P = [0, 1, 2].map(i => dgroup.reduce((s, o) => s + o.b.p[i], 0) / dgroup.length);
  console.log(`\n★ 主位移簇 Δ=(${D.map(v => v.toFixed(1)).join(', ')})  ×${dgroup.length}  θ=${theta.toFixed(2)}°  簇中心(${P.map(v => v.toFixed(1)).join(',')})`);

  // ④ 扫候选
  const N = bufA.length - 64;
  const hits = [];
  for (let off = 0; off <= N; off += 4) {
    if (bufA.readFloatLE(off + 60) !== 1) continue;
    const px = bufA.readFloatLE(off + 48), py = bufA.readFloatLE(off + 52), pz = bufA.readFloatLE(off + 56);
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
    if (Math.abs(px) < 100 || Math.abs(pz) < 100) continue;
    const pos = [px, py, pz];
    if (dist3(pos, P) > 300) continue;
    const r0 = [bufA.readFloatLE(off), bufA.readFloatLE(off + 4), bufA.readFloatLE(off + 8)];
    const r1 = [bufA.readFloatLE(off + 16), bufA.readFloatLE(off + 20), bufA.readFloatLE(off + 24)];
    const r2 = [bufA.readFloatLE(off + 32), bufA.readFloatLE(off + 36), bufA.readFloatLE(off + 40)];
    const rows = [r0, r1, r2];
    let ok = true;
    for (const v of rows) { const l = Math.hypot(v[0], v[1], v[2]); if (!Number.isFinite(l) || Math.abs(l - 1) > 0.01) { ok = false; break; } }
    if (!ok) continue;
    const d01 = r0[0] * r1[0] + r0[1] * r1[1] + r0[2] * r1[2];
    const d02 = r0[0] * r2[0] + r0[1] * r2[1] + r0[2] * r2[2];
    const d12 = r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2];
    if (Math.abs(d01) > 0.01 || Math.abs(d02) > 0.01 || Math.abs(d12) > 0.01) continue;
    let best = 1e9;
    for (const v of rows) {
      const h = Math.hypot(v[0], v[2]);
      if (h < 0.2) continue;
      const e = Math.min(Math.abs(norm180(azim(v[0], v[2]) - theta)), Math.abs(norm180(azim(v[0], v[2]) - theta - 180)));
      if (e < best) best = e;
    }
    if (best > AZ_TOL) continue;
    hits.push({ off, pos, fwd: r2, azErr: best });
  }
  console.log(`\n方位角 ±${AZ_TOL}° 内的候选：${hits.length} 个`);

  // ⑤ 位移复核
  const passed = [];
  for (const h of hits) {
    if (h.off + 64 > bufB.length) continue;
    const posB = [bufB.readFloatLE(h.off + 48), bufB.readFloatLE(h.off + 52), bufB.readFloatLE(h.off + 56)];
    const dB = dist3(posB, h.pos);
    if (dB < 12) continue;
    const dd = dist3([posB[0] - h.pos[0], posB[1] - h.pos[1], posB[2] - h.pos[2]], D);
    if (dd > 1.0) continue;            // 文档：B.pos − A.pos 必须等于 Δ*（实测 0.00）。不放宽，不写半成品
    passed.push({ ...h, posB, dB, dd });
  }
  passed.sort((x, y) => x.dd - y.dd);
  console.log(`位移 >12 且方向接近主簇的：${passed.length} 个`);
  for (const p of passed.slice(0, 8)) {
    console.log(`  off 0x${p.off.toString(16)}  方位差 ${p.azErr.toFixed(2)}°  位移 ${p.dB.toFixed(1)}  与主位移差 ${p.dd.toFixed(1)}  pos(${p.pos.map(v => v.toFixed(1)).join(',')})`);
  }
  if (!passed.length) return console.log('\n✗ 没有候选同时满足（方位 + 位移）');

  const w = passed[0];
  const f2 = [bufB.readFloatLE(w.off + 32), bufB.readFloatLE(w.off + 36), bufB.readFloatLE(w.off + 40)];
  const yaw = azim(f2[0], f2[2]);
  const pitch = Math.asin(Math.max(-1, Math.min(1, f2[1]))) * 180 / Math.PI;
  console.log(`\n★★ 最佳 off 0x${w.off.toString(16)}  yaw ${yaw.toFixed(2)}°  pitch ${pitch.toFixed(2)}°  与主位移差 ${w.dd.toFixed(2)}`);
  fs.writeFileSync(PKGS + '/session.json', JSON.stringify({
    pid, region_idx: scene.idx, region_start: String(R.start), region_size: String(R.size),
    camera_matrix_off: w.off, player_node_mo: null,
    camera_node_id: null, camera_node_mo: null, player_node_id: null,
    player_pos: w.posB.map(v => +v.toFixed(3)),
    yaw_at_locate: +yaw.toFixed(2), pitch_at_locate: +pitch.toFixed(2),
    walk_delta: D.map(v => +v.toFixed(3)),
    ts: new Date().toISOString(), tag: 'vivo',
  }, null, 1));
  console.log('✓ session.json 已写入');
})();
