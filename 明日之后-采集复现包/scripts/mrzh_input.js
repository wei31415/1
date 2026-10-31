#!/usr/bin/env node
// mrzh_input.js - 输入层（常驻 PowerShell 助手版）
// 依据：实测 C# 编译的 exe 里调 keybd_event 不进游戏 ✗，PowerShell 直接调有效 ✓
//       所以这里 spawn 一个常驻 powershell 跑 input_helper.ps1，用 stdin 驱动
'use strict';
const { spawn, execFileSync } = require('child_process');

const PSH = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const HELPER = 'D:/workspace2/mrzh-tools/input_helper.ps1';

class Input {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.buf = '';
    this.waiters = [];
    this.starting = null;
  }

  static queryHwnd() {
    try {
      const out = execFileSync(PSH, ['-NoProfile', '-Command',
        "$p=Get-Process -Name MuMuNxDevice -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object -First 1; if($p){'{0:X}' -f [int64]$p.MainWindowHandle}"],
        { encoding: 'latin1', timeout: 8000 }).trim();
      return /^[0-9A-Fa-f]+$/.test(out) ? out : null;
    } catch (e) { return null; }
  }

  start() {
    if (this.proc && this.ready) return Promise.resolve(true);
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve) => {
      try {
        this.proc = spawn(PSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER],
          { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        this.proc.stdout.setEncoding('latin1');
        this.proc.stdout.on('data', (d) => {
          this.buf += d;
          let i;
          while ((i = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, i).trim();
            this.buf = this.buf.slice(i + 1);
            if (!line) continue;
            if (line === 'READY') {
              this.ready = true;
              const h = Input.queryHwnd();
              if (h) { this.waiters.push(() => {}); try { this.proc.stdin.write('HWND 0x' + h + '\n'); } catch (e) {} }
              resolve(true);
              continue;
            }
            const w = this.waiters.shift();
            if (w) w(line);
          }
        });
        this.proc.on('exit', () => { this.proc = null; this.ready = false; this.starting = null; });
        setTimeout(() => { if (!this.ready) resolve(false); }, 5000);
      } catch (e) { resolve(false); }
    });
    return this.starting;
  }

  send(cmd, timeoutMs = 6000) {
    return this.start().then((ok) => {
      if (!ok) return 'ERR not-ready';
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve('ERR timeout'), timeoutMs);
        this.waiters.push((line) => { clearTimeout(t); resolve(line); });
        try { this.proc.stdin.write(cmd + '\n'); } catch (e) { clearTimeout(t); resolve('ERR write'); }
      });
    });
  }

  async refresh() {
    const h = Input.queryHwnd();
    if (h) { const r = await this.send('HWND 0x' + h); if (r.startsWith('OK')) return r; }
    return this.send('REFRESH');
  }
  async focus() { return this.send('FOCUS'); }
  async kd(vkHex) { return this.send('KD ' + vkHex); }
  async ku(vkHex) { return this.send('KU ' + vkHex); }
  async tap(vkHex) { return this.send('TAP ' + vkHex); }
  async move(dx, dy) { return this.send('M ' + Math.round(dx) + ' ' + Math.round(dy)); }
  async click() { return this.send('CLICK'); }
  async sleep(ms) { return this.send('SLEEP ' + ms); }
  async hold(vkHex, ms) { await this.kd(vkHex); await this.send('SLEEP ' + ms, ms + 8000); await this.ku(vkHex); }
  stop() { try { this.proc.stdin.write('QUIT\n'); } catch (e) {} try { this.proc.kill(); } catch (e) {} this.proc = null; this.ready = false; this.starting = null; }
}

const VK = { W: '57', A: '41', S: '53', D: '44', F: '46', SPACE: '20' };

module.exports = { Input, VK };
