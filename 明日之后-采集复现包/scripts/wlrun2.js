#!/usr/bin/env node
// wlrun2.js - 白名单巡回：走到点 → 按坐标找节点 → 站位 → 射线咬死 → F×2 + 左键×6 → 下一个点
// 选目标只认白名单坐标（3 米内的场景节点），不做任何形状/高度猜测。
// 点上没有节点就直接跳过，不空挥。
// 用法:
//   node wlrun2.js              # 从最近的点开始，跑一遍全部
//   node wlrun2.js --only 3     # 只跑按距离排序后的第 3 个
//   node wlrun2.js --type stone # 只跑 type=stone 的点
//   node wlrun2.js --loop       # 跑完再从头
'use strict';
const fs = require('fs');
const core = require('./mrzh_core.js');
const { Input, VK } = require('./mrzh_input.js');
const aim = require('./mrzh_aim.js');

const WL_PATH = 'D:/workspace2/mrzh-pkgs/whitelist_spawns.json';
const LOOP = process.argv.includes('--loop');
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? parseInt(process.argv[i + 1], 10) : 0; })();
const TYPE = (() => { const i = process.argv.indexOf('--type'); return i > 0 ? process.argv[i + 1] : null; })();
const MAP = (() => { const i = process.argv.indexOf('--map'); return i > 0 ? process.argv[i + 1] : null; })();

const GAP_MIN = 6, GAP_MAX = 20;   // 玩家→目标表面 0.6~2.0 米
const ARRIVE = 40;                 // 到点：玩家水平距 ≤4.0 米（不站到石头上，留出俯仰角余量）
const MATCH = 30;                  // 坐标匹配容差 3.0 米
const HIT_MAX = 40;                // ★ 射线命中距离 ≤4.0 米才挖
const CAM_BACK = 22;               // 相机在玩家身后约 2.2 米

const norm = a => { while (a > 180) a -= 360; while (a < -180) a += 360; return a; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const releaseAll = async (inp) => { for (const k of ['W', 'A', 'S', 'D']) await inp.ku(VK[k]); };

// ---------- 绕行记忆（跨点位共享：同一处卡点不再从第 1 级重来，且自动换边）----------
const BLOCK_MEM = [];
const MEM_R = 80;          // 8 米内视为同一片障碍（侧移一步就是 2~4.5 米，半径必须比它大）
const MEM_TTL = 90000;     // 记忆寿命 90 秒
const MEM_FAR = 150;       // 离开卡点 15 米以上才忘掉

function memNearest(x, z) {
  const now = Date.now();
  let best = null, bd = 1e9;
  for (const m of BLOCK_MEM) {
    if (now - m.t > MEM_TTL) continue;
    const d = Math.hypot(m.x - x, m.z - z);
    if (d < MEM_R && d < bd) { bd = d; best = m; }
  }
  return best;
}
function memRecord(x, z, side, level) {
  const now = Date.now();
  const m = memNearest(x, z);
  if (m) { m.x = x; m.z = z; m.side = side; m.level = level; m.t = now; }
  else BLOCK_MEM.push({ x, z, side, level, t: now });
  while (BLOCK_MEM.length > 24) BLOCK_MEM.shift();
}
function memPrune(x, z) {
  const now = Date.now();
  for (let i = BLOCK_MEM.length - 1; i >= 0; i--) {
    const m = BLOCK_MEM[i];
    if (now - m.t > MEM_TTL || Math.hypot(m.x - x, m.z - z) > MEM_FAR) BLOCK_MEM.splice(i, 1);
  }
}

// 侧移：按住 A/D + 连点跳跃，按"实际走出多少米"停，不是按固定时间
async function strafe(inp, s, dirKey, meters, maxMs = 2400) {
  const a = core.getPlayerAndCam(s);
  if (!a) return 0;
  const ax = a.cx, az = a.cz;
  await inp.kd(VK[dirKey]);
  let moved = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await inp.tap(VK.SPACE);
    await sleep(170);
    const b = core.getPlayerAndCam(s);
    if (!b) continue;
    moved = Math.hypot(b.cx - ax, b.cz - az);
    if (moved >= meters * 10) break;
  }
  await inp.ku(VK[dirKey]);
  return moved;
}

// ---------- 寻路：鼠标转视角 → 按死 W + 连点跳跃；坐标不动判卡住 ----------
async function navTo(inp, s, X, Z, stopPlayer, maxSteps = 240) {
  const stopCam = stopPlayer + CAM_BACK;
  let hist = [], walking = false, sideFlip = false;
  // 连续卡住计数：只要距目标没有实质进展就只增不减，防止在 1~2 级之间反复
  let stuckRun = 0, bestD = 1e9, detourSide = 0;
  const clearHist = () => { hist = []; };
  for (let step = 1; step <= maxSteps; step++) {
    const pc = core.getPlayerAndCam(s);
    if (!pc) { await sleep(80); continue; }
    const d = Math.hypot(X - pc.cx, Z - pc.cz);
    if (d <= stopCam) {
      if (walking) await inp.ku(VK.W);
      console.log(`  ✓ 到点（玩家≈${((d - CAM_BACK) / 10).toFixed(2)}m）`);
      return true;
    }
    const err = norm(Math.atan2(X - pc.cx, Z - pc.cz) * 180 / Math.PI - pc.yaw);
    if (Math.abs(err) > 4) {
      if (walking) { await inp.ku(VK.W); walking = false; }
      await inp.move(clamp(err * 3.7, -170, 170), 0);
      await sleep(130);
      clearHist();
      continue;
    }
    hist.push({ x: pc.cx, z: pc.cz, t: Date.now() });
    while (hist.length > 8) hist.shift();
    if (walking && hist.length >= 4) {
      const a = hist[0], b = hist[hist.length - 1];
      if (b.t - a.t >= 850 && Math.hypot(b.x - a.x, b.z - a.z) < 4) {
        await inp.ku(VK.W); walking = false; clearHist();
        const cur = { x: b.x, z: b.z };
        const m = memNearest(cur.x, cur.z);
        stuckRun++;
        // 距目标有实质进展（比本点历史最好成绩再近 5 米）才允许清零
        if (d < bestD - 50) { bestD = d; stuckRun = 1; }
        else if (d < bestD) bestD = d;
        // 级数 = max(记忆里的级数+1, 连续卡住次数)，绝不回落
        let level = Math.max(m ? m.level + 1 : 1, stuckRun);
        // 认死一边：只有同一侧升到 4 级以上才换边（换边是最后手段，不是每次都用）
        let useSideCache;
        if (m && level >= 4) useSideCache = -m.side;
        else useSideCache = m ? m.side : detourSide;
        if (!useSideCache) { sideFlip = !sideFlip; useSideCache = sideFlip ? 1 : -1; detourSide = useSideCache; }
        const useSide = useSideCache;
        if (level > 6) {
          console.log(`  ✗ 卡点 (${cur.x.toFixed(0)}, ${cur.z.toFixed(0)}) 已升到第 ${level} 级 → 放弃这个点`);
          await releaseAll(inp);
          return false;
        }
        memRecord(cur.x, cur.z, useSide, level);
        const dirKey = useSide > 0 ? 'D' : 'A';
        const sideCN = useSide > 0 ? '右' : '左';
        console.log(`  ${step}: 卡住 (${cur.x.toFixed(0)}, ${cur.z.toFixed(0)}) ` +
          (m ? `← 记忆命中（上次第${m.level}级走${m.side > 0 ? '右' : '左'}）→ 第${level}级走${sideCN}`
             : `→ 新卡点，第${level}级走${sideCN}`));
        if (level === 1) {
          await strafe(inp, s, dirKey, 1.2);
        } else if (level === 2) {
          await strafe(inp, s, dirKey, 2.5);
        } else if (level === 3) {
          await strafe(inp, s, dirKey, 2.5);
          await inp.kd(VK.S); await sleep(300); await inp.ku(VK.S);
        } else if (level === 4) {
          await strafe(inp, s, dirKey, 4.0, 3200);
        } else {
          console.log(`     第 5 级：转 ${useSide > 0 ? '+' : '−'}60° 走 3 米再回正`);
          await inp.move(clamp(useSide * 60 * 3.7, -220, 220), 0);
          await sleep(200);
          const t0 = Date.now();
          await inp.kd(VK.W);
          while (Date.now() - t0 < 2200) { await inp.tap(VK.SPACE); await sleep(200); }
          await inp.ku(VK.W);
        }
        const after = core.getPlayerAndCam(s);
        if (after) console.log(`     绕行实际位移 ${Math.hypot(after.cx - b.x, after.cz - b.z).toFixed(1)} 单位`);
        await sleep(180);
        continue;
      }
    }
    if (step % 20 === 1) memPrune(pc.cx, pc.cz);
    await inp.kd(VK.W);
    walking = true;
    await inp.tap(VK.SPACE);
    if (step % 8 === 1) console.log(`  ${step}: 玩家≈${((d - CAM_BACK) / 10).toFixed(2)}m`);
    await sleep(260);
  }
  if (walking) await inp.ku(VK.W);
  await releaseAll(inp);
  return false;
}

function makeReader(s) {
  const st = { cache: null, at: 0, nodes: null, pc: null };
  st.refresh = function (force) {
    if (!force && st.cache && Date.now() - st.at < 2000) return st.cache;
    st.pc = core.getPlayerAndCam(s);
    if (!st.pc) return st.cache;
    const buf = aim.dumpScene();
    if (!buf) return st.cache;
    st.nodes = aim.parseNodes(buf);
    const pid = aim.playerNodeId(st.nodes, st.pc);
    const P = pid === null ? null : st.nodes.find(n => n.id === pid);
    st.cache = P ? { x: P.p[0], y: P.p[1], z: P.p[2], id: P.id }
      : { x: st.pc.px, y: st.pc.cy, z: st.pc.pz, id: null };
    st.at = Date.now();
    return st.cache;
  };
  return st;
}

// 严格按坐标找节点：XZ 距离 < MATCH 单位，取最近
function nodeAt(nodes, pc, X, Z) {
  const sc = aim.filterScenery(nodes, pc);
  const pid = aim.playerNodeId(sc, pc);
  return sc.filter(n => n.id !== pid)
    .map(n => ({ n, d: Math.hypot(n.p[0] - X, n.p[2] - Z) }))
    .filter(o => o.d <= MATCH)
    .sort((a, b) => a.d - b.d)[0] || null;
}

async function standoff(inp, s, pr, T) {
  for (let k = 1; k <= 12; k++) {
    pr.refresh(true);
    const Tn = pr.nodes.find(n => n.id === T.id) || T;
    const P = pr.cache;
    if (!P) return null;
    const gap = aim.distPointToOBB(Tn, [P.x, P.y, P.z]);
    console.log(`    站位 ${k}: 表面距 ${(gap / 10).toFixed(2)}m${gap === 0 ? '（在盒子里）' : ''}`);
    if (gap >= GAP_MIN && gap <= GAP_MAX) return gap;
    const err = norm(Math.atan2(Tn.p[0] - pr.pc.cx, Tn.p[2] - pr.pc.cz) * 180 / Math.PI - pr.pc.yaw);
    if (Math.abs(err) > 5) { await inp.move(clamp(err * 3.7, -170, 170), 0); await sleep(140); continue; }
    if (gap < GAP_MIN) { await inp.kd(VK.S); await sleep(210); await inp.ku(VK.S); }
    else { await inp.kd(VK.W); await sleep(210); await inp.ku(VK.W); }
    await sleep(150);
  }
  await releaseAll(inp);
  return null;
}

async function aimLock(inp, s, pr, T) {
  // 内部只瞄一次就验证一次：重试由外面的"调位置"循环负责，避免重复 dump 拖时间
  for (let attempt = 1; attempt <= 1; attempt++) {
    pr.refresh(true);
    const Tn = pr.nodes.find(n => n.id === T.id) || T;
    const aY = Tn.p[1] + (Tn.mx[1] + Tn.mn[1]) / 2;
    for (let k = 1; k <= 14; k++) {
      const pc = core.getPlayerAndCam(s);
      if (!pc) { await sleep(80); continue; }
      const vx = Tn.p[0] - pc.cx, vy = aY - pc.cy, vz = Tn.p[2] - pc.cz;
      const dh = Math.hypot(vx, vz);
      const B = Math.atan2(vx, vz) * 180 / Math.PI;
      const Pp = clamp(Math.atan2(vy, dh) * 180 / Math.PI, -52, 42);
      const ey = norm(B - pc.yaw), ep = Pp - pc.pitch;
      if (Math.abs(ey) < 0.25 && Math.abs(ep) < 0.25) break;
      await inp.move(clamp(ey * 8, -800, 800), clamp(-ep * 8, -350, 350));
      await sleep(110);
    }
    await sleep(180);
    pr.refresh(true);
    const { hits } = aim.crosshairHit(pr.nodes, pr.pc);
    if (hits[0]) console.log(`      射线最近命中 0x${hits[0].node.id.toString(16)} ${hits[0].node.fp} ${(hits[0].dist / 10).toFixed(2)}m`);
    const self = hits.find(h => h.node.id === T.id);
    if (self && self.dist <= HIT_MAX) {
      console.log(`      ✓ 射线穿过目标，命中距离 ${(self.dist / 10).toFixed(2)}m ≤ ${(HIT_MAX / 10).toFixed(0)}m`);
      return self.dist;
    }
    if (self) console.log(`      △ 射线穿过目标，但命中距离 ${(self.dist / 10).toFixed(2)}m > ${(HIT_MAX / 10).toFixed(0)}m → 不算咬死`);
    else console.log('      → 没咬住，补正');
  }
  return null;
}

async function swing(inp, s, pr, T) {
  await inp.tap(VK.F); console.log('      F 1/2');
  await sleep(400);
  await inp.tap(VK.F); console.log('      F 2/2');
  await sleep(600);
  // 每次左键之前先重新咬住目标，避免采集过程中准心抖开
  for (let i = 1; i <= 6; i++) {
    const d = await aimLock(inp, s, pr, T);
    await inp.click();
    console.log(`      左键 ${i}/6` + (d ? `（咬住 ${(d / 10).toFixed(2)}m）` : '（未咬住）'));
    await sleep(1000);
  }
}

(async () => {
  const s = core.loadSession();
  if (!s) return console.log('没有 session.json');
  if (String(core.getPid()) !== String(s.pid)) return console.log('★ pid 变了，要重新定位');

  const wlAll = JSON.parse(fs.readFileSync(WL_PATH, 'utf8').replace(/^\uFEFF/, ''));
  const wl = wlAll.filter(w => (TYPE ? (w.type || 'unknown') === TYPE : true)
                            && (MAP ? w.map === MAP : true));
  const inp = new Input();
  if (!(await inp.start())) return console.log('★ 输入助手失败');
  const pr = makeReader(s);

  let P = pr.refresh(true);
  if (!P) return console.log('★ 读不到玩家位置');
  console.log(`玩家 (${P.x.toFixed(0)}, ${P.z.toFixed(0)})   白名单 ${wl.length} 个点${TYPE ? '（type=' + TYPE + '）' : ''}${MAP ? '（map=' + MAP + '）' : ''}`);

  const order = wl.map((w, i) => ({ w, i, d: Math.hypot(w.x - P.x, w.z - P.z) })).sort((a, b) => a.d - b.d);
  order.forEach((o, k) => console.log(`  ${k + 1}. ${o.w.type || 'unknown'} (${o.w.x}, ${o.w.z})  ${(o.d / 10).toFixed(1)}m`));

  let round = 0, doneCount = 0, skipCount = 0;
  do {
    round++;
    for (let k = 0; k < order.length; k++) {
      if (ONLY && k + 1 !== ONLY) continue;
      const { w } = order[k];
      console.log(`\n======== 第 ${round} 轮 / 点 ${k + 1}/${order.length}：${w.type || 'unknown'} (${w.x}, ${w.z}) ========`);

      const reached = await navTo(inp, s, w.x, w.z, ARRIVE);
      await releaseAll(inp);
      await sleep(300);
      if (!reached) {
        console.log('  ✗ 没走到点位 → 跳过（不动手）');
        skipCount++;
        w.lastAt = new Date().toISOString();
        try { fs.writeFileSync(WL_PATH, JSON.stringify(wlAll, null, 1)); } catch (e) {}
        continue;
      }

      // 场景节点是流式加载的：到点后要等模型进内存，重试读 3 次
      let hit = null;
      for (let tryNo = 1; tryNo <= 3; tryNo++) {
        pr.refresh(true);
        hit = nodeAt(pr.nodes, pr.pc, w.x, w.z);
        console.log(`    读取 ${tryNo}/3：${(MATCH / 10).toFixed(0)}m 内${hit ? '有节点 0x' + hit.n.id.toString(16) + '（差 ' + (hit.d / 10).toFixed(2) + 'm）' : '没节点'}`);
        if (hit) break;
        await sleep(1200);
      }
      if (!hit) {
        console.log(`  ✗ 连续 3 次读到 ${(MATCH / 10).toFixed(0)}m 内没有节点 → 跳过（不空挥）`);
        skipCount++;
        w.lastAt = new Date().toISOString();
        try { fs.writeFileSync(WL_PATH, JSON.stringify(wlAll, null, 1)); } catch (e) {}
        continue;
      }
      const T = hit.n;
      console.log(`  节点 0x${T.id.toString(16)}  指纹 ${T.fp}  与白名单坐标差 ${(hit.d / 10).toFixed(2)}m`);
      const g = await standoff(inp, s, pr, T);
      if (g === null) console.log('  △ 站位没进 0.6~2.0m 窗口');
      // 射线没进 4 米 → 调位置再试，不许直接放弃
      let hitDist = null;
      for (let adj = 1; adj <= 8; adj++) {
        hitDist = await aimLock(inp, s, pr, T);
        if (hitDist) break;
        pr.refresh(true);
        const Tn = pr.nodes.find(n => n.id === T.id) || T;
        // 先把视角对准目标水平方向
        for (let t = 0; t < 4; t++) {
          const pc = core.getPlayerAndCam(s);
          const err = norm(Math.atan2(Tn.p[0] - pc.cx, Tn.p[2] - pc.cz) * 180 / Math.PI - pc.yaw);
          if (Math.abs(err) < 5) break;
          await inp.move(clamp(err * 3.7, -170, 170), 0);
          await sleep(130);
        }
        console.log(`    调整位置 ${adj}/8：朝目标推一步再重瞄`);
        await inp.kd(VK.W); await sleep(300); await inp.ku(VK.W);
        await sleep(250);
      }
      if (!hitDist) {
        console.log(`  ✗ 调了 8 次位置，射线命中距离仍在 ${(HIT_MAX / 10).toFixed(0)}m 外 → 跳过`);
        skipCount++;
        w.lastAt = new Date().toISOString();
        try { fs.writeFileSync(WL_PATH, JSON.stringify(wlAll, null, 1)); } catch (e) {}
        continue;
      }
      await inp.kd(VK.W); await sleep(110); await inp.ku(VK.W); await sleep(300);
      await swing(inp, s, pr, T);
      doneCount++;
      w.lastAt = new Date().toISOString();
      w.lastResult = 'swung';
      try { fs.writeFileSync(WL_PATH, JSON.stringify(wlAll, null, 1)); } catch (e) {}
    }
  } while (LOOP);

  await releaseAll(inp);
  inp.stop();
  console.log(`\n======== 跑完：采集 ${doneCount} 个点，跳过 ${skipCount} 个点（无节点） ========`);
})();
