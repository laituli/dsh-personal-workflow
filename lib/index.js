/**
 * dsh-personal-workflow —— 个人工作流的知识注入器（profile 作用域）。
 *
 * 为什么不用 <DSH_HOME>/skills：那是**所有 profile 共享**的目录，某个 profile 的插件
 * 往里写文件会污染别的 profile。正确做法是**热加载**：把本插件自己的 skills/ 目录
 * 注册进 skill 加载器（服务定义 @deepseek-ai/dsh-skill），随 ctx 作用域存在/销毁 ——
 * 「有插件 = agent 知道这套工作流；插件卸载 = 自动移除」。
 *
 * 已知 API（@deepseek-ai/dsh-skill，服务定义角色）：
 *   - SkillRegistry.registerProvider(create)：注册“目录来源”provider；
 *     provider 需实现 list(options)（返回数组或 {candidates, complete}），可含 get(name)/name；
 *   - SkillRegistry.register(skill)：注册运行期 skill（随 ctx 作用域自动注销）；
 *     校验要求：name 为 kebab-case、description 非空、invocation 合法。
 * 待确认（见 docs/skill-injection.md）：服务注入名、invocation 字段形状。
 *
 * 生效方式：宿主侧插件只在启动时装配 → 首次安装/升级需**冷重启**。
 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const name = 'dsh-personal-workflow';
export const inject = [];

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK_SKILLS = join(HERE, '..', 'skills');
const PROVIDER_NAME = 'dsh-personal-workflow';

/** 读取包内 skills/<kebab-name>/SKILL.md，解析 frontmatter（name/description/whenToUse）。 */
export async function loadPackagedSkills() {
  let dirs = [];
  try { dirs = (await readdir(PACK_SKILLS, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch (e) { return []; }
  const out = [];
  for (const dir of dirs) {
    const file = join(PACK_SKILLS, dir, 'SKILL.md');
    let raw = '';
    try { raw = await readFile(file, 'utf8'); } catch (e) { continue; }
    const meta = {};
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    if (m) {
      for (const line of m[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line.trim());
        if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
      }
    }
    out.push({
      name: meta.name || dir,
      description: meta.description || '',
      whenToUse: meta.whenToUse,
      content: raw,
      path: file,
      source: 'dsh-personal-workflow',
    });
  }
  return out;
}

export function apply(ctx) {
  let registered = null;

  ctx.effect(() => {
    let disposed = false;
    const setup = async (skill) => {
      const skills = await loadPackagedSkills();
      if (!skills.length) { ctx.logger?.warn?.('[dsh-personal-workflow] skills/ 为空，未注册任何 skill'); return; }
      // provider 形态：catalog 来自本插件目录（等价“把目录加进加载器路径列表”）
      if (typeof skill.registerProvider === 'function') {
        skill.registerProvider(() => ({
          name: PROVIDER_NAME,
          list: async () => skills.map((s) => ({
            name: s.name,
            description: s.description,
            whenToUse: s.whenToUse,
            content: s.content,
            path: s.path,
            source: s.source,
            provider: PROVIDER_NAME,
          })),
        }));
        registered = 'provider';
        ctx.logger?.info?.('[dsh-personal-workflow] 已注册 skill provider: ' + skills.map((s) => s.name).join(', '));
        return;
      }
      // 运行期注册形态（若宿主只提供 register(skill)）
      if (typeof skill.register === 'function') {
        for (const s of skills) {
          skill.register({ name: s.name, description: s.description, invocation: { model: true, user: true }, content: s.content });
        }
        registered = 'runtime';
        ctx.logger?.info?.('[dsh-personal-workflow] 已运行期注册 skill: ' + skills.map((s) => s.name).join(', '));
        return;
      }
      ctx.logger?.warn?.('[dsh-personal-workflow] 未找到 skill 服务的注册接口（registerProvider/register），本次未注入；见 docs/skill-injection.md');
    };
    try {
      // 服务注入名待确认（候选 skill / skills）；两路都试，命中即用
      if (typeof ctx.inject === 'function') {
        ctx.inject(['skill'], (scope) => { void setup(scope.skill).catch((e) => ctx.logger?.warn?.('[dsh-personal-workflow] 注入失败: ' + (e && e.message ? e.message : e))); });
      } else {
        const svc = ctx.get?.('skill') ?? ctx.get?.('skills');
        if (svc) void setup(svc);
      }
    } catch (e) {
      ctx.logger?.warn?.('[dsh-personal-workflow] 装配异常（已忽略）: ' + (e && e.message ? e.message : e));
    }
    return () => {
      if (disposed) return;
      disposed = true;
      // provider/runtime 均随 ctx 作用域销毁，无需手动清理文件（这正是热加载的好处）
      ctx.logger?.info?.('[dsh-personal-workflow] 已卸载（skill 注册随作用域移除，方式: ' + (registered || 'none') + '）');
    };
  }, 'dsh-personal-workflow: skill provider');
}
