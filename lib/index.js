/**
 * dsh-personal-workflow —— 个人工作流的知识注入器（profile 作用域，热加载）。
 *
 * 不用 <DSH_HOME>/skills：那是所有 profile 共享的 user root（rank 400），某个 profile 的
 * 插件往里写文件会污染其它 profile。正确做法是**热加载**——把本插件自己的 skills/ 目录
 * 注册进 skill 服务（@deepseek-ai/dsh-skill，0.1.2-rc.1 里通过 ctx.skills 访问），
 * 注册随 ctx 作用域的 fiber 存在，插件卸载即自动移除。
 *
 * 已核实的注册 API（依据子 agent 对 @deepseek-ai/dsh-skill 与本机装配链的调研）：
 *   - ctx.skills.register({ name, description, content, ... }) → 运行期 skill，返回 fiber 级 disposer；
 *     invocation 缺省 = 模型与用户都可调用；同层同名先到先得。
 *   - ctx.skills.registerProvider(create) → create(control) 返回 { name, list, get }；
 *     control = { signal, invalidate }，失效由 provider 自行驱动（无 TTL）。
 *   磁盘 root 与优先级：项目 .dsh/skills(100) → .agents/skills(200) → customSkillDirs(300)
 *     → <dshHome>/skills(400) → ~/.agents/skills(500) → bundled(600)。
 *
 * 生效方式：宿主侧插件只在启动时装配 → 首次安装/升级需**冷重启**。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const name = 'dsh-personal-workflow';
export const inject = [];

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK_SKILLS = join(HERE, '..', 'skills');
const PROVIDER_NAME = 'dsh-personal-workflow';

/** 解析 SKILL.md 的 frontmatter（name/description/whenToUse），同步读取以便在装配帧内注册。 */
function parseFrontmatter(raw) {
  const meta = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return meta;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return meta;
}

/** 读取包内 skills/<kebab-name>/SKILL.md → skill 定义数组（同步）。 */
export function loadPackagedSkills() {
  let dirs = [];
  try { dirs = readdirSync(PACK_SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (e) { return []; }
  const out = [];
  for (const dir of dirs) {
    const file = join(PACK_SKILLS, dir, 'SKILL.md');
    let raw = '';
    try { raw = readFileSync(file, 'utf8'); } catch (e) { continue; }
    const meta = parseFrontmatter(raw);
    const description = meta.description || '';
    if (!meta.name || !description) continue; // 缺必填字段就不注册（避免宿主校验抛错）
    out.push({
      name: meta.name,
      description: description,
      whenToUse: meta.whenToUse,
      content: raw,
      path: file,
      source: PROVIDER_NAME,
      provider: PROVIDER_NAME,
    });
  }
  return out;
}

function toDefinition(s) {
  const def = { name: s.name, description: s.description, content: s.content, source: s.source, provider: s.provider, path: s.path };
  if (s.whenToUse) def.whenToUse = s.whenToUse;
  return def;
}

export function apply(ctx) {
  // 关键：ctx.skills 是 Cordis 服务，必须显式 inject 才能读——直接 `ctx.skills`
  // 会抛 "cannot get property \"skills\" without inject"，让 loader entry 应用失败，
  // 整个宿主起不来（真宿主实测）。同理不要读 ctx.logger（也用 optional chaining 探测），
  // 这里统一走 console，零额外服务依赖。
  ctx.inject(['skills'], (sctx) => {
    sctx.effect(() => {
      const skills = loadPackagedSkills();
      const svc = sctx.skills;
      const disposers = [];
      if (!skills.length) {
        console.warn('[dsh-personal-workflow] skills/ 为空，未注册任何 skill');
        return () => {};
      }
      if (svc && typeof svc.registerProvider === 'function') {
      // provider 形态：catalog 来自插件自己的 skills/ 目录（等价“把目录加入加载器路径列表”）
      const dispose = svc.registerProvider(() => ({
        name: PROVIDER_NAME,
        list: async () => skills.map(toDefinition),
        get: async (name) => {
          const hit = skills.find((s) => s.name === name);
          return hit ? toDefinition(hit) : undefined;
        },
      }));
      if (typeof dispose === 'function') disposers.push(dispose);
      console.info('[dsh-personal-workflow] 已注册 skill provider: ' + skills.map((s) => s.name).join(', '));
    } else if (svc && typeof svc.register === 'function') {
      for (const s of skills) {
        const dispose = svc.register({ name: s.name, description: s.description, content: s.content });
        if (typeof dispose === 'function') disposers.push(dispose);
      }
      console.info('[dsh-personal-workflow] 已运行期注册 skill: ' + skills.map((s) => s.name).join(', '));
    } else {
      console.warn('[dsh-personal-workflow] 未找到 ctx.skills 注册接口（register/registerProvider），本次未注入；见 docs/skill-injection.md');
    }
    return () => {
      for (const d of disposers) { try { d(); } catch (e) { /* 忽略 */ } }
      console.info('[dsh-personal-workflow] 已卸载（skill 注册随 fiber 移除）');
    };
    }, 'dsh-personal-workflow: skill provider');
  });
}
