#!/usr/bin/env node
/**
 * verify-boot：把一个（或几个）**开发中的插件**放进真实宿主里启动一次，验证插件树
 * 能装配成功。存在的理由很硬：插件在真宿主里访问未 inject 的 ctx 属性会抛
 * `cannot get property "x" without inject`，让 loader entry 应用失败 → 整个
 * `dsh web` 起不来（用户实测被这条打挂过）。单元桩测不出这个，只有真宿主能测出。
 *
 * 用法: node scripts/verify-boot.mjs [--port 13150] <插件目录> [更多插件目录...]
 * 每个插件目录需含 package.json（name 即 bundle 名）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DSH_BIN = process.env.DSH_BIN
  || 'C:/Users/lai/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js';
const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 13150;
const pluginDirs = args.filter((a, i) => !a.startsWith('--') && i !== portIdx + 1);
if (!pluginDirs.length) {
  console.error('用法: node scripts/verify-boot.mjs [--port 13150] <插件目录> [...]');
  process.exit(2);
}

const results = [];
const ok = (name, good, detail = '') => {
  results.push({ name, good });
  console.log(`  ${good ? '✅' : '❌'} ${name}${!good && detail ? ` — ${detail}` : ''}`);
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vboot-'));
const webDir = path.join(home, 'profiles', 'web');
fs.mkdirSync(path.join(webDir, 'node_modules'), { recursive: true });

const names = [];
for (const dir of pluginDirs) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  names.push(pkg.name);
  fs.symlinkSync(fs.realpathSync(dir), path.join(webDir, 'node_modules', pkg.name), 'junction');
}
fs.writeFileSync(path.join(webDir, 'package.json'), `${JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: Object.fromEntries(names.map((n) => [n, 'link:dev'])),
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...names],
      patchReload: 'live',
    },
  },
}, null, 2)}\n`);
fs.writeFileSync(path.join(webDir, 'cordis.yml'), '[]\n');
fs.writeFileSync(path.join(webDir, 'cordis.patch.yml'), [
  '# verify-boot isolated profile',
  '- id: webserver',
  '  config:',
  '    host: 127.0.0.1',
  `    port: ${PORT}`,
  '',
].join('\n'));

const logPath = path.join(home, 'boot.log');
const logFd = fs.openSync(logPath, 'w');
console.log(`[verify-boot] home=${home} port=${PORT} 插件=${names.join(', ')}`);
const child = spawn(process.execPath, [DSH_BIN, 'web', '--no-open'], {
  env: { ...process.env, DSH_HOME: home, DSH_WEB_URL: `http://127.0.0.1:${PORT}` },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
});
let exited = null;
child.on('exit', (code) => { exited = code; });

const started = Date.now();
let token = '';
while (Date.now() - started < 90_000) {
  if (exited !== null) break;
  const log = fs.readFileSync(logPath, 'utf8');
  const m = /dsh web:\s+http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)/.exec(log);
  if (m) { token = m[1]; break; }
  await new Promise((r) => setTimeout(r, 500));
}
const log = fs.readFileSync(logPath, 'utf8');
ok('宿主启动成功（插件树装配通过）', exited === null && token !== '', exited !== null
  ? `进程退出码 ${exited}：\n${log.split('\n').filter((l) => /Error|error|without inject/.test(l)).slice(0, 6).join('\n')}`
  : '90s 内未打印 dsh web 地址');

if (token) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    const cookies = res.headers.getSetCookie?.() ?? [];
    const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
    const st = await fetch(`http://127.0.0.1:${PORT}/dsh-stable-network/status`, { headers: cookie ? { Cookie: cookie } : {} });
    const body = await st.text();
    ok('dsh-stable-network 已装载（/dsh-stable-network/status 可用）', st.status === 200, `HTTP ${st.status} ${body.slice(0, 160)}`);
  } catch (err) {
    ok('dsh-stable-network 已装载（/dsh-stable-network/status 可用）', false, err.message);
  }
  ok('dsh-personal-workflow 已装载（skill provider 注册日志）', /已注册 skill provider|已运行期注册 skill/.test(log),
    log.split('\n').filter((l) => l.includes('dsh-personal-workflow')).slice(0, 3).join(' | ') || '日志里没有注册行');
}

try { child.kill(); } catch { /* 已退出 */ }
await new Promise((r) => setTimeout(r, 800));
try { fs.closeSync(logFd); } catch { /* 忽略 */ }

const failed = results.filter((r) => !r.good).length;
console.log(`\n结果: ${results.length - failed}/${results.length} 通过（home=${home}）`);
process.exitCode = failed ? 1 : 0;
