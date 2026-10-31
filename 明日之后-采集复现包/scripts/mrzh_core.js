#!/usr/bin/env node
// mrzh_core.js - 明日之后 内存读取核心层（阶段2）
// 只做四件事：单块 64KB 读取 / 相机+玩家 / 节点探针 / 自愈定位
// 全部无状态依赖，可被 bot.js 直接 require
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ADB = 'D:/Program Files/Netease/MuMu/nx_main/adb.exe';
const DEV = 'emulator-5554';
const TMP = 'D:/workspace2/tmp';
const PKGS = 'D:/workspace2/mrzh-pkgs';
const BLOCK = 65536;

function ensureTmp() { try { fs.mkdirSync(TMP, { recursive: true }); } catch (e) {} }

// ---------- 进程 / 设备 ----------
// 包名会随渠道变化：com.netease.mrzh / com.netease.mrzh.vivo / .mi / .huawei ...
const PKG_LIST = ['com.netease.mrzh', 'com.netease.mrzh.vivo', 'com.netease.mrzh.mi',
  'com.netease.mrzh.huawei', 'com.netease.mrzh.oppo', 'com.netease.mrzh.uc'];
function getPid() {
  for (const p of PKG_LIST) {
    try {
      const out = execFileSync(ADB, ['-s', DEV, 'shell', `pidof ${p}`], { encoding: 'latin1', timeout: 8000 }).trim();
      const v = parseInt(String(out).split(/\s+/)[0], 10);
      if (Number.isFinite(v) && v > 0) return v;
    } catch (e) { }
  }
  // 兜底：ps 里按关键字找（跳过 :PushService 之类子进程）
  try {
    const out = execFileSync(ADB, ['-s', DEV, 'shell', 'ps -A -o PID,NAME'], { encoding: 'latin1', timeout: 8000 });
    for (const line of out.split('\n')) {
      if (!/com\.netease\.mrzh/.test(line)) continue;
      if (/:\S/.test(line)) continue;
      const m = /^\s*(\d+)/.exec(line);
      if (m) return parseInt(m[1], 10);
    }
  } catch (e) { }
  return 0;
}

function adbRoot() {
  try {
    const out = execFileSync(ADB, ['-s', DEV, 'shell', 'id'], { encoding: 'latin1' }).trim();
    if (out.includes('uid=0')) return true;
    execFileSync(ADB, ['-s', DEV, 'root'], { encoding: 'latin1' });
    spawnSync('C:/Windows/System32/cmd.exe', ['/c', 'timeout', '/t', '2', '/nobreak'], { stdio: 'ignore' });
    const out2 = execFileSync(ADB, ['-s', DEV, 'shell', 'id'], { encoding: 'latin1' }).trim();
    return out2.includes('uid=0');
  } catch (e) { return false; }
}

// ---------- 单块读取（49ms）----------
// 读包含 absAddr 的那一个 64KB 对齐块；返回 {buf, off} 或 null
let _lastRead = 0;
function readBlock64K(absAddr) {
  ensureTmp();
  const aligned = Math.floor(absAddr / BLOCK) * BLOCK;
  const skip = Math.floor(absAddr / BLOCK);
  const off = absAddr - aligned;
  try {
    const out = execFileSync(ADB,
      ['-s', DEV, 'exec-out', `dd if=/proc/${getPidCached()}/mem bs=${BLOCK} skip=${skip} count=1`],
      { maxBuffer: 2 * 1024 * 1024, encoding: 'buffer', timeout: 15000 });
    if (!out || out.length < off + 16) { _lastRead = -1; return null; }
    _lastRead = Date.now();
    return { buf: out, off, aligned };
  } catch (e) { return null; }
}

let _pid = 0;
let _pidAt = 0;
function getPidCached() {
  const now = Date.now();
  if (!_pid || now - _pidAt > 5000) { _pid = getPid(); _pidAt = now; }
  return _pid;
}

// 批量读区域（初始化时用，需要控制内存：分块读，分析完立刻释放）
function readRegionStream(regionStart, regionSize, chunkBytes, onChunk) {
  ensureTmp();
  const tmpf = path.join(TMP, 'region.bin');
  let done = 0;
  while (done < regionSize) {
    const thisLen = Math.min(chunkBytes, regionSize - done);
    const skip = Math.floor((regionStart + done) / BLOCK);
    const cnt = Math.ceil(thisLen / BLOCK);
    try {
      spawnSync('C:/Windows/System32/cmd.exe',
        ['/c', `"${ADB}" -s ${DEV} exec-out dd if=/proc/${getPidCached()}/mem bs=${BLOCK} skip=${skip} count=${cnt} 2>nul > "${tmpf}"`],
        { stdio: 'ignore', timeout: 120000 });
      const st = fs.statSync(tmpf);
      if (!st || st.size < 4096) break;
      const buf = fs.readFileSync(tmpf);
      onChunk(buf, done);
      done += buf.length;
    } catch (e) { break; }
  }
  try { fs.unlinkSync(tmpf); } catch (e) {}
  return done;
}

// ---------- 相机 / 玩家 ----------
// session.json: { pid, region_idx, region_start, region_size, camera_matrix_off, player_pos_off }
function loadSession() {
  try { return JSON.parse(fs.readFileSync(path.join(PKGS, 'session.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { return null; }
}
function loadRegions() {
  try { return JSON.parse(fs.readFileSync(path.join(PKGS, 'regions.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { return null; }
}

function camAbs(session) {
  const regions = loadRegions();
  const r = regions.find(x => Number(x.idx) === Number(session.region_idx));
  if (!r) return 0;
  const st = BigInt(r.start);
  const al = st - (st % BigInt(BLOCK));
  return Number(al + BigInt(session.camera_matrix_off));
}

function getPlayerAndCam(session) {
  const abs = camAbs(session);
  if (!abs) return null;
  const blk = readBlock64K(abs);
  if (!blk) return null;
  const b = blk.buf, off = blk.off;
  if (off + 64 > b.length) return null;
  const fx = b.readFloatLE(off + 32), fy = b.readFloatLE(off + 36), fz = b.readFloatLE(off + 40);
  const cx = b.readFloatLE(off + 48), cy = b.readFloatLE(off + 52), cz = b.readFloatLE(off + 56);
  const cw = b.readFloatLE(off + 60);
  // 自愈：正交归一 + 位置合理
  const fl = Math.hypot(fx, fy, fz);
  if (!Number.isFinite(cx) || Math.abs(cx) < 1 || Math.abs(cx) > 100000) return null;
  if (Math.abs(fl - 1) > 0.02 || Math.abs(cw - 1) > 0.01) return null;
  const yaw = Math.atan2(fx, fz) * 180 / Math.PI;
  const pitch = Math.asin(Math.max(-1, Math.min(1, fy))) * 180 / Math.PI;
  // 玩家近似 = 相机沿视线后退 32 单位（水平）
  // ★ 相机在玩家【后面】，所以玩家 = 相机 + 水平前方*32（原来是减号，错了）
  const hz = Math.hypot(fx, fz) || 1;
  const px = cx + (fx / hz) * 32, pz = cz + (fz / hz) * 32;
  return { cx, cy, cz, fx, fy, fz, yaw, pitch, px, pz, at: Date.now() };
}

// ---------- 直读玩家节点坐标 ----------
function readPlayer(session) {
  if (!session || session.player_node_mo === undefined) return null;
  const regions = loadRegions();
  const r = regions.find(x => Number(x.idx) === Number(session.region_idx));
  if (!r) return null;
  const st = BigInt(r.start);
  const al = st - (st % BigInt(BLOCK));
  const absPos = Number(al + BigInt(session.player_node_mo)) + 32;   // marker + 32 = position
  const blk = readBlock64K(absPos);
  if (!blk) return null;
  const o = blk.off;
  if (o + 16 > blk.buf.length) return null;
  const x = blk.buf.readFloatLE(o), y = blk.buf.readFloatLE(o + 4), z = blk.buf.readFloatLE(o + 8);
  if (!Number.isFinite(x) || Math.abs(x) < 1 || Math.abs(x) > 100000) return null;
  return { x, y, z };
}
// ---------- 节点探针（49ms）----------
// 传入节点基址（= marker 偏移 - 32 的绝对地址），以及原始 id 与坐标
function probeNodeAlive(absBase, expectId, expectX, expectZ) {
  const PROBE = 0x0a;
  const markerAbs = absBase + 32;
  const blk = readBlock64K(markerAbs);
  if (!blk) return { state: 'READ_FAIL' };
  const b = blk.buf, off = blk.off;
  if (off + 48 > b.length) return { state: 'READ_FAIL' };
  const m0 = b[off], m1 = b[off + 1], m2 = b[off + 2], m3 = b[off + 3], m4 = b[off + 4], m5 = b[off + 5];
  const id = b.readUInt32LE(off + 6);
  const x = b.readFloatLE(off + 32), y = b.readFloatLE(off + 36), z = b.readFloatLE(off + 40);
  const markerOk = (m0 === 0x0e && m1 === 0x01 && m2 === 0x22 && m3 === 0 && m4 === 0 && m5 === 0);
  const idOk = (id === expectId);
  const posOk = Math.hypot(x - expectX, z - expectZ) < 6;
  if (markerOk && idOk && posOk) return { state: 'ALIVE', id, x, y, z };
  return { state: 'GONE', marker: `${m0.toString(16)}${m1.toString(16)}${m2.toString(16)}`, id, x, y, z };
}

module.exports = {
  ADB, DEV, TMP, PKGS, BLOCK,
  getPid: getPidCached, adbRoot,
  readBlock64K, readRegionStream,
  loadSession, loadRegions, camAbs,
  getPlayerAndCam, probeNodeAlive, readPlayer,
  lastReadMs: () => _lastRead
};
