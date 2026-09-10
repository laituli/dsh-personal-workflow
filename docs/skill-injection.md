# skill 热注入机制（调研记录）

## 结论：不要写 `<DSH_HOME>/skills`

那是**所有 profile 共享**的目录；某个 profile 的插件往里写文件会污染其它 profile，且卸载后可能残留。
正确做法是**热加载**：把插件自己的 `skills/` 目录注册进 skill 加载器，随 ctx 作用域存在与销毁。

## 已核实的 API（`@deepseek-ai/dsh-skill`，本机 0.1.0-rc.8）

该包是 **Service Definition 角色**（技能能力的服务定义）：它只负责合并各 provider 的目录、解析重名、对外暴露摘要与定义；
**具体来源由 provider 决定**（如 `@deepseek-ai/dsh-skill-filesystem` 从目录读）。

`SkillRegistry`（extends `Service`）暴露：

| 方法 | 语义 |
|---|---|
| `registerProvider(create)` | 注册 provider；`create(control)` 返回 provider 对象，需实现 `list(options)`（返回数组或 `{ candidates, complete }` 观测），可含 `get(name)` 与 `name`；名字 `runtime` 保留 |
| `register(skill)` | 注册**运行期 skill**，随 ctx 作用域自动注销；校验：`name` 为 kebab-case、`description` 非空、`invocation` 合法 |

provider 提供的定义（`validateDefinition`）字段：`name`、`description`、`whenToUse?`、`invocation`、`source`、`provider`、`content`、`path?`，全部为字符串类型（`whenToUse`/`path` 可选）。
优先级：`RUNTIME_RANK = 250`、`BUNDLED_SKILL_RANK = 600`（数值语义待确认）。

## 仍未确认（下一步要落实）

1. **服务注入名**：是 `skill` 还是 `skills`（本机测试用两路兜底）；
2. **`invocation` 字段形状**（`validateInvocation` 的期望：可能形如 `{ model: boolean, user: boolean }`）；
3. 是否必须提供 `get(name)`，以及 `list()` 的 `complete` 语义；
4. 装载顺序：provider 注册是否必须在宿主装配期（同步帧）完成——若必须，则 `ctx.effect` 内 async 注册可能被忽略，需要改为同步注册。

## 现行实现（v0.1.0）

`lib/index.js`：装载时读取包内 `skills/*/SKILL.md`（解析 frontmatter）→ 优先 `registerProvider`，退而 `register`；
两路都不可用时**明确告警**（不写用户目录、不静默失败）；卸载时打印“注册随作用域移除”。
