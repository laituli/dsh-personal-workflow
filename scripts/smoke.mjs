#!/usr/bin/env node
/**
 * smoke：本插件对外契约的离线校验——重点是 provider 返回的 skill 定义必须满足
 * 宿主 @deepseek-ai/dsh-skill 的 validateCandidate 规则（rank 必填是踩过的坑：
 * 少一个 rank，用户在界面上直接看到 "returned skill ... with an invalid rank"）。
 * 规则逐条抄自 dsh-skill/lib/index.js 的 validateCandidate/validateInvocation。
 */
import { loadPackagedSkills, toDefinition } from '../lib/index.js';

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const results = [];
const ok = (name, good, detail = '') => {
  results.push({ name, good });
  console.log(`  ${good ? '✅' : '❌'} ${name}${!good && detail ? ` — ${detail}` : ''}`);
};

const skills = loadPackagedSkills();
ok('包内至少有一个 skill（skills/<name>/SKILL.md）', skills.length > 0, `找到 ${skills.length} 个`);

for (const s of skills.map(toDefinition)) {
  const who = `skill ${s.name}`;
  ok(`${who}: 名称合规`, SKILL_NAME.test(s.name), s.name);
  ok(`${who}: description 非空字符串`, typeof s.description === 'string' && s.description.length > 0);
  ok(`${who}: source/provider 为字符串且 provider 等于自身`, typeof s.source === 'string' && typeof s.provider === 'string' && s.provider === 'dsh-personal-workflow');
  ok(`${who}: rank 是有限数字（宿主硬要求）`, typeof s.rank === 'number' && Number.isFinite(s.rank), String(s.rank));
  ok(`${who}: whenToUse 若存在必须是字符串`, s.whenToUse === undefined || typeof s.whenToUse === 'string');
  ok(`${who}: invocation 若存在则两个字段都是布尔`,
    s.invocation === undefined || (typeof s.invocation.modelInvocable === 'boolean' && typeof s.invocation.userInvocable === 'boolean'),
    JSON.stringify(s.invocation));
  ok(`${who}: path 若存在必须是字符串`, s.path === undefined || typeof s.path === 'string');
  ok(`${who}: content 非空（SKILL.md 正文）`, typeof s.content === 'string' && s.content.length > 0);
}

const failed = results.filter((r) => !r.good).length;
console.log(`\n结果: ${results.length - failed}/${results.length} 通过`);
process.exitCode = failed ? 1 : 0;
