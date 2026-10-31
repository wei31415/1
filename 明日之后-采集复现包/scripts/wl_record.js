// wl_record.js - 记录准心正对的资源坐标（射线-OBB 求交，不是估算）
// 用法: node wl_record.js <type> [地图名]
//   node wl_record.js stone 晴空麦田
'use strict';
const core = require('./mrzh_core.js');
const aim = require('./mrzh_aim.js');
const fs = require('fs');

const WL = 'D:/workspace2/mrzh-pkgs/whitelist_spawns.json';
const TYPE = process.argv[2] || 'stone';
const MAP = process.argv[3] || null;      // 地图名：不同图坐标不一样，必须分开存

const s = core.loadSession();
if (!s) { console.log('没有 session.json'); process.exit(1); }
const pc = core.getPlayerAndCam(s);
if (!pc) { console.log('读相机失败'); process.exit(1); }
const buf = aim.dumpScene();
if (!buf) { console.log('转储失败'); process.exit(1); }
const nodes = aim.parseNodes(buf);
const pid = aim.playerNodeId(nodes, pc);
const { hits } = aim.crosshairHit(nodes, pc);

console.log(`相机 (${pc.cx.toFixed(2)}, ${pc.cy.toFixed(2)}, ${pc.cz.toFixed(2)})  yaw ${pc.yaw.toFixed(1)}  pitch ${pc.pitch.toFixed(1)}`);
console.log(`玩家节点 ${pid === null ? '未识别' : '0x' + pid.toString(16)}   节点总数 ${nodes.length}`);
if (!hits.length) { console.log('★ 准心没命中任何候选物体（对着空气/地面）'); process.exit(0); }

console.log('--- 准心命中列表 ---');
hits.slice(0, 5).forEach((h, i) => {
  console.log(`  ${i}. ${(h.dist / 10).toFixed(2)}m  0x${h.node.id.toString(16)}  指纹 ${h.node.fp}  @(${h.node.p.map(v => v.toFixed(3)).join(', ')})`);
});

const t = hits.find(h => h.node.id !== pid && h.node.fp !== '200000/200000/200000');
if (!t) { console.log('★ 只命中玩家/天空盒，没东西可记'); process.exit(0); }

const wl = JSON.parse(fs.readFileSync(WL, 'utf8').replace(/^\uFEFF/, ''));
const entry = {
  x: +t.node.p[0].toFixed(3),
  y: +t.node.p[1].toFixed(3),
  z: +t.node.p[2].toFixed(3),
  type: TYPE,
  map: MAP,
  action: 'LCLICK',
  fp: t.node.fp,
  nodeId: '0x' + t.node.id.toString(16),
  source: 'crosshair-ray',
  hits: 1,
  created: new Date().toISOString(),
};
// 同一坐标（3 米内）已有同类记录就不重复写
const dup = wl.find(w => w.type === TYPE && (w.map || null) === MAP && Math.hypot(w.x - entry.x, w.z - entry.z) < 30);
if (dup) {
  console.log(`△ 附近已有同类记录 (${dup.x}, ${dup.z})，只更新指纹/时间`);
  Object.assign(dup, { fp: entry.fp, nodeId: entry.nodeId, lastAt: entry.created });
} else {
  wl.push(entry);
  console.log(`✓ 已记录 #${wl.length}：${TYPE} (${entry.x}, ${entry.y}, ${entry.z})  指纹 ${entry.fp}`);
}
fs.writeFileSync(WL, JSON.stringify(wl, null, 1));
console.log(`白名单现有 ${wl.length} 条`);
