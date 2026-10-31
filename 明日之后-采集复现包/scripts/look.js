#!/usr/bin/env node
// look.js - 实时回答一个问题：准心现在到底对着什么？
// 用法: node look.js [半径m=25]
'use strict';
const core = require('./mrzh_core.js');
const aim = require('./mrzh_aim.js');

const R = parseFloat(process.argv[2] || '25');
const s = core.loadSession();
if (!s) { console.log('没有 session.json'); process.exit(1); }
const pc = core.getPlayerAndCam(s);
if (!pc) { console.log('读相机失败（session 过期？）'); process.exit(1); }

const buf = aim.dumpScene();
if (!buf) { console.log('转储失败'); process.exit(1); }
const nodes = aim.parseNodes(buf);
const { hits } = aim.crosshairHit(nodes, pc);

console.log(`相机 (${pc.cx.toFixed(1)}, ${pc.cy.toFixed(1)}, ${pc.cz.toFixed(1)})  yaw ${pc.yaw.toFixed(1)}°  pitch ${pc.pitch.toFixed(1)}°`);
console.log(`玩家 ≈ (${pc.px.toFixed(1)}, ${pc.pz.toFixed(1)})   节点总数 ${nodes.length}`);
console.log('');
if (!hits.length) {
  console.log('★ 准心没打到任何候选物体（对着空气 / 对着地面）');
} else {
  for (const h of hits.slice(0, 6)) {
    const n = h.node;
    const mark = h === hits[0] ? '★' : ' ';
    console.log(`${mark} 最近命中 ${(h.dist / 10).toFixed(2)}m  0x${n.id.toString(16).padStart(4, '0')}  指纹 ${n.fp}  高 ${n.sy.toFixed(1)}  @(${n.p.map(v => v.toFixed(0)).join(',')})`);
  }
  console.log(`\n★ 准心对着：0x${hits[0].node.id.toString(16)}  指纹 ${hits[0].node.fp}  距离 ${(hits[0].dist / 10).toFixed(2)}m`);
}

// 附近候选 + 需要转多少度
const list = aim.filterScenery(nodes, pc);
const cand = list.map(n => ({ n, d: Math.hypot(n.p[0] - pc.px, n.p[2] - pc.pz) }))
  .filter(o => o.d <= R * 10).sort((a, b) => a.d - b.d);
console.log(`\n=== ${R}m 内候选 ${cand.length} 个（方位角：相对当前朝向，正=右）===`);
for (const o of cand) {
  const n = o.n;
  const bearing = Math.atan2(n.p[0] - pc.cx, n.p[2] - pc.cz) * 180 / Math.PI;
  const dyaw = ((bearing - pc.yaw + 540) % 360) - 180;
  const dh = Math.hypot(n.p[0] - pc.cx, n.p[2] - pc.cz);
  const dpitch = Math.atan2((n.p[1] + n.mx[1]) - pc.cy, dh) * 180 / Math.PI - pc.pitch;
  const tr = aim.aimTrace(n, pc);
  console.log(`  ${(o.d / 10).toFixed(1).padStart(5)}m  0x${n.id.toString(16).padStart(4, '0')}  指纹 ${n.fp.padEnd(22)} 需转 yaw ${dyaw.toFixed(0).padStart(4)}° pitch ${dpitch.toFixed(0).padStart(4)}°  ${tr.hit ? '← 已命中' : ''}`);
}
