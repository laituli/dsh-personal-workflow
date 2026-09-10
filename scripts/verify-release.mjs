#!/usr/bin/env node
/**
 * verify-release：**发布前**的最后一关——把「标签里的内容」（不是工作树）解出来，
 * 装进一个隔离 DSH_HOME 的真实宿主里启动并跑一遍关键动作。
 *
 * 为什么必须存在：
 *  1) 插件在真宿主里访问未 inject 的 ctx 属性会抛 `cannot get property "x" without
 *     inject`，loader entry 应用失败 → 整个 `dsh web` 起不来（用户实测被打挂过）；
 *  2) `files` 字段漏带运行时文件（skills/、rescue/ 等）只有装出来才会暴露；
 *  3) 备份类插件必须验证「目的地切换后不再沿用旧根 GitHub 状态」这条 0.11.8 的修复。
 *
 * 用法:
 *   node scripts/verify-release.mjs [--port 13160] <插件仓目录>[@<tag>] ...
 *   - 带 @tag：先 `git archive <tag>` 解到临时目录，验证的正是 pnpm 会拉到的内容；
 *   - 不带：直接 junction 工作树（改代码时的快速回归）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const DSH_BIN = process.env.DSH_BIN
  || 'C:/Users/lai/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js';
const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const PORT = portIdx >= 0 ? Number(argv[portIdx + 1]) : 13160;
const specs = argv.filter((a, i) => !a.startsWith('--') && i !== portIdx + 1);
if (!specs.length) {
  console.error('用法: node scripts/verify-release.mjs [--port 13160] <插件仓目录>[@<tag>] ...');
  process.exit(2);
}

const results = [];
const ok = (name, good, detail = '') => {
  results.push({ name, good });
  console.log(`  ${good ? '✅' : '❌'} ${name}${!good && detail ? ` — ${detail}` : ''}`);
};

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vrel-'));
const pluginDirs = [];
for (const spec of specs) {
  const at = spec.lastIndexOf('@');
  const dir = at > 1 ? spec.slice(0, at) : spec;
  const tag = at > 1 ? spec.slice(at + 1) : null;
  if (!tag) { pluginDirs.push(fs.realpathSync(dir)); continue; }
  // 标签内容 = pnpm 从 URL#tag 会拉到的内容；用 git archive 精确取出
  const name = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
  const safe = name.replace(/[@/]/g, '_'); // scope 名不能直接当路径用
  const out = path.join(stage, safe);
  const tarPath = path.join(stage, `${safe}.tar`);
  const a = spawnSync('git', ['-C', dir, 'archive', '--format=tar', '-o', tarPath, tag], { encoding: 'utf8' });
  if (a.status !== 0) { console.error(`git archive ${tag} 失败: ${a.stderr}`); process.exit(2); }
  fs.mkdirSync(out, { recursive: true });
  const x = spawnSync('tar', ['-xf', tarPath, '-C', out], { encoding: 'utf8' });
  if (x.status !== 0) { console.error(`解包 ${tag} 失败: ${x.stderr}`); process.exit(2); }
  // 依赖 peers：解出来的目录不在 pnpm 布局里，插件 import 的 @deepseek-ai/* 找不到。
  // 借用商店里已解析好的 peer 目录（<.pnpm>/<pkg>/node_modules）——安装后 pnpm 也是这么给的。
  const profileDir = process.env.VERIFY_PEERS_PROFILE || path.join(os.homedir(), '.dsh', 'profiles', 'web');
  try {
    const installed = fs.realpathSync(path.join(profileDir, 'node_modules', name));
    const peers = path.join(installed, '..', '..');
    if (fs.existsSync(path.join(peers, '@deepseek-ai')) && !fs.existsSync(path.join(out, 'node_modules'))) {
      fs.symlinkSync(peers, path.join(out, 'node_modules'), 'junction');
    }
  } catch { /* 未安装过该包：无 peers 可用，交给 verify 报错 */ }
  pluginDirs.push(out);
  console.log(`[verify-release] ${name}@${tag} → ${out}`);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vrel-home-'));
const webDir = path.join(home, 'profiles', 'web');
fs.mkdirSync(path.join(webDir, 'node_modules'), { recursive: true });
const names = [];
for (const dir of pluginDirs) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  names.push(pkg.name);
  const linkPath = path.join(webDir, 'node_modules', pkg.name);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true }); // scope 子目录
  fs.symlinkSync(fs.realpathSync(dir), linkPath, 'junction');
}
const hasBackup = names.includes('@xiaoyuyu6420/dsh-backup');
fs.writeFileSync(path.join(webDir, 'package.json'), `${JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: Object.fromEntries(names.map((n) => [n, 'link:dev'])),
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...names], patchReload: 'live' } },
}, null, 2)}\n`);
fs.writeFileSync(path.join(webDir, 'cordis.yml'), '[]\n');
fs.writeFileSync(path.join(webDir, 'cordis.patch.yml'), [
  '# verify-release isolated profile', '- id: webserver', '  config:', '    host: 127.0.0.1', `    port: ${PORT}`, '',
].join('\n'));

const logPath = path.join(home, 'boot.log');
const logFd = fs.openSync(logPath, 'w');
console.log(`[verify-release] home=${home} port=${PORT} 插件=${names.join(', ')}`);
const child = spawn(process.execPath, [DSH_BIN, 'web', '--no-open'], {
  env: { ...process.env, DSH_HOME: home, DSH_WEB_URL: `http://127.0.0.1:${PORT}` },
  stdio: ['ignore', logFd, logFd], windowsHide: true,
});
let exited = null;
child.on('exit', (code) => { exited = code; });

const base = `http://127.0.0.1:${PORT}`;
let token = '';
let cookie = '';
const started = Date.now();
while (Date.now() - started < 90_000 && exited === null && !token) {
  const m = /dsh web:\s+http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)/.exec(fs.readFileSync(logPath, 'utf8'));
  if (m) token = m[1]; else await new Promise((r) => setTimeout(r, 500));
}
const log = () => fs.readFileSync(logPath, 'utf8');
ok('宿主启动成功（插件树装配通过）', exited === null && Boolean(token), exited !== null
  ? `退出码 ${exited}：\n${log().split('\n').filter((l) => /Error|without inject|not defined/.test(l)).slice(0, 6).join('\n')}`
  : '90s 内未打印 dsh web 地址');

if (token) {
  try {
    const res = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  } catch { /* 忽略 */ }
  const rpc = async (method, args = {}, timeoutMs = 60_000) => {
    try {
      const r = await fetch(`${base}/api/backupPanel/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify({ type: 'client-request', rpcId: `vrel-${method}-${Date.now()}`, method: `backupPanel/${method}`, payload: { args } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const j = JSON.parse(await r.text());
      return j?.type === 'server-response' ? (j.result?.value ?? j.result) : { ok: false, raw: String(j).slice(0, 200) };
    } catch (e) { return { ok: false, raw: e.message }; }
  };
  const http = async (url, opts = {}) => {
    const r = await fetch(`${base}${url}`, { ...opts, headers: { ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) } });
    return { status: r.status, text: await r.text() };
  };

  if (hasBackup) {
    // 目的地必须先切到隔离目录：否则备份会打到真实 ~/Desktop/dsh-backups（并继承
    // 该根 auto.json 里真实 GitHub 仓库）——这一步不成立就中止后续动作，绝不动真实数据
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vrel-dest-'));
    const set0 = await http('/dsh-backup/settings');
    const rev = JSON.parse(set0.text).revision;
    const set1 = await http('/dsh-backup/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: rev, destination: dest }),
    });
    ok('目的地已切到隔离目录（不污染真实备份根）', set1.status === 200 && set1.text.includes(path.basename(dest)), `HTTP ${set1.status} ${set1.text.slice(0, 160)}`);
    const gh = await rpc('githubStatus');
    ok('目的地切换后未沿用旧根 GitHub 状态', gh?.repo == null, JSON.stringify(gh).slice(0, 200));
    const st = await rpc('status');
    ok('status 可用且列出归档字段', Array.isArray(st?.backups) && typeof st?.destination === 'string', JSON.stringify(st).slice(0, 200));
    ok('status 含跨机通用停机/启动指令（0.11.9）',
      typeof st?.restart?.portableStopCmd === 'string' && typeof st?.restart?.portableRelaunchCmd === 'string'
      && !/Desktop|dsh-backups/.test(st.restart.portableStopCmd), JSON.stringify(st?.restart).slice(0, 200));
    ok('status 含「从 0 安装」清单（URL#tag）', Array.isArray(st?.installPlan?.profiles), JSON.stringify(st?.installPlan).slice(0, 160));
    const bk = await rpc('backup', {}, 120_000);
    ok('备份动作成功（隔离目的地）', bk?.ok === true && String(bk?.path ?? '').includes(path.basename(dest)), JSON.stringify(bk).slice(0, 200));
    const pre = await rpc('restore', { selector: 'latest', dryRun: true });
    ok('恢复 dry-run 预览可用', pre?.ok === true && pre?.dryRun === true, JSON.stringify(pre).slice(0, 160));
  }

  if (names.includes('dsh-stable-network')) {
    const r = await http('/dsh-stable-network/status');
    ok('dsh-stable-network 已装载（状态端点可用）', r.status === 200 && /"online"|"state"|"pending"/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 160)}`);
  }
  if (names.includes('dsh-personal-workflow')) {
    ok('dsh-personal-workflow 已装载（skill provider 注册日志）',
      /已注册 skill provider|已运行期注册 skill/.test(log()),
      log().split('\n').filter((l) => l.includes('dsh-personal-workflow')).slice(0, 3).join(' | ') || '日志无注册行');
  }
}

try { child.kill(); } catch { /* 已退出 */ }
await new Promise((r) => setTimeout(r, 800));
try { fs.closeSync(logFd); } catch { /* 忽略 */ }

const failed = results.filter((r) => !r.good).length;
console.log(`\n结果: ${results.length - failed}/${results.length} 通过（home=${home} 临时内容=${stage}）`);
process.exitCode = failed ? 1 : 0;
