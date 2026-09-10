/**
 * dsh-personal-workflow —— 个人工作流的知识注入器。
 *
 * 为什么用「插件 + skill」而不是文档：
 *   agent 的入口是会话技能目录（skill），仓库里的 md 它看不到；
 *   而插件装载即注入、卸载即移除 —— 「有插件 = agent 知道这套工作流，拔掉 = 干净」。
 *
 * 注入方式（v0.1.0，文件式）：
 *   把包内 skills/<name>/ 复制到 DSH skill 搜索目录下（默认 <DSH_HOME>/skills/<name>/），
 *   卸载时删除。若后续确认 DSH 提供可编程注册接口（服务/包），再改为服务注册。
 *
 * 生效方式：宿主侧插件只在启动时装配 —— **改宿主代码或首次安装都需要冷重启**；
 * 仅改 skills/ 下的内容也需要重新装载（冷重启）才会重新注入。
 */
import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const name = 'dsh-personal-workflow';
export const inject = [];

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK_SKILLS = join(HERE, '..', 'skills');
/** 注入到会话技能目录时使用的子目录名（= skill 名）。 */
const SKILL_NAME = 'dsh-personal-workflow';

/** 解析 DSH_HOME：优先 launchEnvironment，其次环境变量，最后 ~/.dsh。 */
function resolveDshHome(ctx) {
  try {
    const env = ctx.get('launchEnvironment');
    const v = env?.get('DSH_HOME')?.value;
    if (v) return String(v).split('\\').join('/');
  } catch { /* 无 launchEnvironment */ }
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv) return String(fromEnv).split('\\').join('/');
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return String(home).split('\\').join('/') + '/.dsh';
}

/** 技能搜索目录（候选，按存在性/可写性挑选）。 */
function skillRoots(dshHome) {
  return [`${dshHome}/skills`];
}

export function apply(ctx, config = {}) {
  const dshHome = resolveDshHome(ctx);
  const target = join(skillRoots(dshHome)[0], SKILL_NAME);
  const injected = [];

  /** 注入：把包内 skills/ 下的每个 skill 目录复制到技能目录。 */
  async function injectSkills() {
    let names = [];
    try { names = await readdir(PACK_SKILLS, { withFileTypes: true }).then((rs) => rs.filter((r) => r.isDirectory()).map((r) => r.name)); } catch { names = []; }
    for (const n of names) {
      const dst = join(skillRoots(dshHome)[0], n);
      await rm(dst, { recursive: true, force: true });
      await mkdir(dst, { recursive: true });
      await cp(join(PACK_SKILLS, n), dst, { recursive: true });
      injected.push(dst);
    }
    if (injected.length) console.log(`[dsh-personal-workflow] 已注入 skill: ${injected.join(', ')}`);
  }

  /** 卸载：移除注入的文件（拔出即没有）。 */
  async function removeSkills() {
    for (const dst of injected) await rm(dst, { recursive: true, force: true }).catch(() => {});
  }

  ctx.effect(() => {
    let disposed = false;
    void (async () => {
      try {
        await injectSkills();
      } catch (err) {
        console.error('[dsh-personal-workflow] 注入失败:', err && err.message ? err.message : err);
      }
    })();
    return () => {
      if (disposed) return;
      disposed = true;
      void removeSkills();
    };
  }, 'dsh-personal-workflow: skill injection');

  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => { void removeSkills(); });
  }
  // 首次装载时打印落点，便于验证
  console.log(`[dsh-personal-workflow] skill 目录: ${target}（存在: ${existsSync(target)}）`);
}
