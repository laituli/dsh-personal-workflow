#!/usr/bin/env node
/**
 * conformance：用**宿主真实代码里的校验器**验证本插件 provider 返回的 skill 定义。
 *
 * 为什么需要它：`invalid rank` 这类错误只在「agent 会话读取 skill 列表」时才冒出来，
 * 想复现就得真的和 agent 对话（费时费钱）。这里直接把宿主 @deepseek-ai/dsh-skill
 * 打包文件里的 SKILL_NAME / validateInvocation / validateCandidate 三个定义抽出来，
 * 用真实规则跑一遍我们的定义——不需要 LLM，也不需要起宿主。
 *
 * 用法: node scripts/conformance-skill-candidate.mjs [--lib <dsh-skill/lib/index.js>] [--pkg <插件目录>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const libPath = argOf('--lib', path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-skill', 'lib', 'index.js',
));
const pkgDir = argOf('--pkg', path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..'));

let host = '';
try { host = fs.readFileSync(libPath, 'utf8'); } catch (e) {
  console.error(`❌ 读不到宿主校验器 ${libPath}: ${e.message}`);
  process.exit(2);
}

// 从宿主打包文件里抽出真实规则（逐字，不重写）
const grab = (name, re) => {
  const m = re.exec(host);
  if (!m) throw new Error(`抽不到 ${name}（宿主实现变了？请更新本脚本）`);
  return m[0];
};
const srcSkillName = grab('SKILL_NAME', /const SKILL_NAME = [^\n]+/);
const srcValidateInvocation = grab('validateInvocation', /function validateInvocation\(invocation, subject\) \{[\s\S]*?\n\}/);
const srcValidateCandidate = grab('validateCandidate', /function validateCandidate\(candidate, providerName\) \{[\s\S]*?\n\}/);
console.log(`[conformance] 规则取自宿主实现: ${libPath}`);

const factory = new Function(`${srcSkillName};\n${srcValidateInvocation}\n${srcValidateCandidate}\nreturn { validateCandidate, validateInvocation, SKILL_NAME };`);
const { validateCandidate, SKILL_NAME } = factory();

const mod = await import(new URL(`file://${path.join(pkgDir, 'lib', 'index.js').split(path.sep).join('/')}`).href);
const skills = mod.loadPackagedSkills().map(mod.toDefinition);
console.log(`[conformance] 被测包: ${pkgDir}（${skills.length} 个 skill）`);

const results = [];
const ok = (name, good, detail = '') => {
  results.push({ name, good });
  console.log(`  ${good ? '✅' : '❌'} ${name}${!good && detail ? ` — ${detail}` : ''}`);
};
ok('包内至少一个 skill', skills.length > 0);
for (const s of skills) {
  try {
    validateCandidate(s, 'dsh-personal-workflow');
    ok(`宿主真实校验器接受 skill "${s.name}"（rank=${s.rank}）`, true);
  } catch (e) {
    ok(`宿主真实校验器接受 skill "${s.name}"`, false, `${e.constructor.name}: ${e.message}`);
  }
  ok(`名称符合宿主 SKILL_NAME 正则`, SKILL_NAME.test(s.name), s.name);
}

// 反向样例：确认这套抽取出来的校验器真的会拒绝坏定义（否则上面的通过没有意义）
try {
  const bad = { ...skills[0], rank: undefined };
  validateCandidate(bad, 'dsh-personal-workflow');
  ok('负样例：缺 rank 应被拒绝', false, '没有被拒绝 → 抽取的校验器可能失效');
} catch (e) {
  ok(`负样例：缺 rank 被拒绝（${e.message.slice(0, 60)}…）`, true);
}

const failed = results.filter((r) => !r.good).length;
console.log(`\n结果: ${results.length - failed}/${results.length} 通过`);
process.exitCode = failed ? 1 : 0;
