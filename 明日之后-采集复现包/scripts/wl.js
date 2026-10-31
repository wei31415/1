#!/usr/bin/env node
// wl.js - 白名单工具
//   用法:
//     node wl.js add <类型> [动作]    把当前玩家位置记进白名单
//         类型: tree/stone/hemp/berry/ore/unknown
//         动作: F | LCLICK（默认 LCLICK）
//     node wl.js list                 列出所有白名单
//     node wl.js near [半径米]        按距离列出
//     node wl.js del <序号>           删除第 N 条
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('./mrzh_core.js');

const WL = path.join(core.PKGS, 'whitelist_spawns.json');

function load() {
  try { const v = JSON.parse(fs.readFileSync(WL, 'utf8').replace(/^\uFEFF/, '')); return Array.isArray(v) ? v : [v]; }
  catch (e) { return []; }
}
function save(v) { fs.writeFileSync(WL, JSON.stringify(v, null, 1)); }

const cmd = process.argv[2] || 'list';

if (cmd === 'add') {
  const type = process.argv[3] || 'unknown';
  const action = process.argv[4] || 'LCLICK';
  const s = core.loadSession();
  if (!s) { console.log('没有 session.json'); process.exit(1); }
  const pid = core.getPid();
  if (String(pid) !== String(s.pid)) { console.log('★ pid 变了，先跑 mrzh_locate.js'); process.exit(1); }
  const pl = core.readPlayer(s);
  const pc = core.getPlayerAndCam(s);
  const pos = pl || (pc ? { x: pc.px, y: pc.cy, z: pc.pz } : null);
  if (!pos) { console.log('★ 读不到玩家位置'); process.exit(1); }
  console.log('玩家位置 (' + pos.x.toFixed(1) + ', ' + (pos.y || 0).toFixed(1) + ', ' + pos.z.toFixed(1) + ')' +
    (pl ? '  [玩家节点直读 ✓]' : '  [近似值 ⚠]'));
  const wl = load();
  // 1.5 米内视为同一点
  const dup = wl.find(w => Math.hypot(w.x - pos.x, w.z - pos.z) < 15);
  if (dup) {
    dup.type = type; dup.action = action; dup.hits = (dup.hits || 1) + 1;
    dup.updated = new Date().toISOString();
    save(wl);
    console.log('该点已存在 → 更新类型为 ' + type + ' / 动作 ' + action + '（hits=' + dup.hits + '）');
  } else {
    wl.push({
      x: +pos.x.toFixed(1), y: +(pos.y || 0).toFixed(1), z: +pos.z.toFixed(1),
      type, action, hits: 1, source: pl ? 'player_node' : 'approx',
      created: new Date().toISOString()
    });
    save(wl);
    console.log('★ 已加入白名单（第 ' + wl.length + ' 条）：' + type + ' / ' + action);
  }
  console.log('');
  console.log('=== 当前白名单（共 ' + wl.length + ' 条）===');
  wl.forEach((w, i) => {
    console.log('  ' + (i + 1) + ') (' + w.x.toFixed(1) + ', ' + w.z.toFixed(1) + ')  ' +
      String(w.type).padEnd(8) + String(w.action).padEnd(8) + ' hits=' + (w.hits || 1));
  });
}
else if (cmd === 'list') {
  const wl = load();
  console.log('=== 白名单（共 ' + wl.length + ' 条）===');
  if (!wl.length) console.log('  （空）');
  wl.forEach((w, i) => {
    console.log('  ' + (i + 1) + ') (' + w.x.toFixed(1) + ', ' + w.z.toFixed(1) + ')  ' +
      String(w.type).padEnd(8) + String(w.action).padEnd(8) + ' hits=' + (w.hits || 1) +
      (w.created ? '  ' + w.created.slice(0, 16) : ''));
  });
}
else if (cmd === 'near') {
  const R = parseFloat(process.argv[3] || '50') * 10;
  const s = core.loadSession();
  const pl = core.readPlayer(s);
  if (!pl) { console.log('读不到玩家位置'); process.exit(1); }
  console.log('玩家 (' + pl.x.toFixed(1) + ', ' + pl.z.toFixed(1) + ')');
  const wl = load().map(w => ({ ...w, d: Math.hypot(w.x - pl.x, w.z - pl.z) }))
    .filter(w => w.d <= R).sort((a, b) => a.d - b.d);
  console.log('=== ' + (R / 10) + ' 米内 ' + wl.length + ' 条 ===');
  wl.forEach((w, i) => {
    console.log('  ' + (i + 1) + ') ' + (w.d / 10).toFixed(1) + 'm  (' + w.x.toFixed(1) + ', ' + w.z.toFixed(1) + ')  ' +
      String(w.type).padEnd(8) + String(w.action).padEnd(8) + ' hits=' + (w.hits || 1));
  });
}
else if (cmd === 'del') {
  const n = parseInt(process.argv[3], 10);
  const wl = load();
  if (!(n >= 1 && n <= wl.length)) { console.log('序号无效'); process.exit(1); }
  const rm = wl.splice(n - 1, 1)[0];
  save(wl);
  console.log('已删除 (' + rm.x + ', ' + rm.z + ')，剩 ' + wl.length + ' 条');
}
else {
  console.log('用法: node wl.js add|list|near|del');
}
