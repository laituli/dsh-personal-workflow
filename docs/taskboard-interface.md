# 任务看板（task-board）接口调研

> 调研对象：本机 DSH 0.1.2-rc.1（`C:\Users\lai\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`）Web profile `web`
> 调研方式：只读（读包内 `src/` 与 `lib/`、读 `~/.dsh` 配置、对运行中的宿主做只读 HTTP 探针）。
> 本文件中的每个结论都给出**绝对路径 + 行号**；推断处均标注「推断」或「未证实」。

---

## 0. 结论速览（TL;DR）

| 问题 | 结论 |
|---|---|
| 谁实现了看板 | 社区包 `@linxin666/dsh-client-ui-task-board@0.3.18`（宿主半边 `lib/index.js`，客户端半边 `lib/client.js`，随包发布 `src/` 源码） |
| 宿主权威 | 宿主进程内存中的账本（`HostTaskLedger.document`）是唯一权威；磁盘 `ledger-v2.json` 只是快照 |
| 宿主对外写入口 | 只有 `POST /api/task-board/action`（回环 + 浏览器同源标记），**没有** typert/RPC 命名空间、**没有** CLI |
| 外部程序能否写 | **能**：本机程序带 `Origin: http://127.0.0.1:3080`（或 `Sec-Fetch-Site: same-origin`）POST 该路由即可（已实测通过闸门） |
| 能否把任务标为 `done` | **没有专用 action**。`move` 只接受 `backlog`/`todo`；`update` 不含 `status`；`done`/`failed` 只能由**真实执行结算**产生。唯一能直接写入 `done` 的是 `import`（v1 迁移旁路，新 id 或 `updatedAt` 更新时生效） |
| UI 能否标 `done` | **不能**。UI 只有拖到「待规划/待办」与 Run/Rerun，`done` 由执行结果决定 |
| 为什么外部改文件被回滚 | 宿主启动时只读一次文件，之后内存为权威；任何一次 commit 会用内存整体原子重写文件（tmp+fsync+rename），且**没有任何磁盘 revision 校验/合并** |
| agent 有无工具/命令 | **无**。包内不注册任何工具、不注册斜杠命令、不注册 typert 命名空间；唯一的 agent 接触面是一个默认**关闭**的系统提示段（`announceToAgent`） |
| skill 注入 | 有官方编程接口：`ctx.skills.register(...)` / `ctx.skills.registerProvider(...)`，随 fiber 卸载自动移除 |

---

## 1. 实现包与文件

### 1.1 包身份

| 项 | 值 |
|---|---|
| 包名 | `@linxin666/dsh-client-ui-task-board` |
| 版本 | `0.3.18` |
| 安装路径 | `C:\Users\lai\.dsh\profiles\web\node_modules\@linxin666\dsh-client-ui-task-board`（Junction → `C:\Users\lai\.dsh\profiles\web\.dsh-module-fallback\node_modules\@linxin666\dsh-client-ui-task-board`） |
| 宿主半边 | `...\dsh-client-ui-task-board\lib\index.js`（源码 `src\index.ts`，ESM） |
| 客户端半边 | `...\dsh-client-ui-task-board\lib\client.js`（源码 `src\client\index.ts`） |
| 数据文件 | `C:\Users\lai\.dsh\task-board\ledger-v2.json`（`schemaVersion: 3`）、`ledger-v2.lock`、`scheduler-v2.json` |
| 上游仓库 | `https://github.com/zhu1090093659/dsh-web.git`（该包 `package.json` 的 `repository`，路径 `packages/dsh-task-board`） |

包内 `src/` 与 `lib/types/*.d.ts` 随 npm 包发布（`package.json` 的 `files` 含 `src`），因此下文行号对安装副本稳定可查。

### 1.2 装载链（为什么这个包会跑起来）

1. `C:\Users\lai\.dsh\profiles\web\package.json` → `dsh.profile.bundles` 含 `@linxin666/dsh-web-all`。
2. `C:\Users\lai\.dsh\profiles\web\node_modules\@linxin666\dsh-web-all\cordis.patch.yml`：
   ```yaml
   # from ../dsh-task-board
   - insert:
       - id: web-ui-task-board
         name: '@linxin666/dsh-web-all/task-board'
         config:
           plugin: '@linxin666/dsh-client-ui-task-board'
   ```
   （该行 id 即插件在 DSH 插件清单中的身份：`web-ui-task-board`）
3. `@linxin666/dsh-web-all\lib\shells\shell.js` 只是二行 re-export（`import { apply, inject } from "../shell.js"`），真正的挂载在 `@linxin666\dsh-web-all\lib\shell.js:104`：`ctx.plugin(plugin, config?.config)`（`lib/shell.js:90` 动态 `import(spec)`，失败进 degraded 记录）。
4. 客户端半边由 DSH 客户端模块系统按 `dsh.client` 声明注入：`@deepseek-ai\dsh-client-modules\lib\index.js:67-68`（"scans the host Loader's entries for packages declaring `dsh.client`"）、`:142-146`（校验 `dsh.client.platform` / `inject` / `external`）。本包声明见其 `package.json` 的 `dsh.client`：`platform: "web"`，`inject: [dsh-client-connection, dsh-client-ui-settings, dsh-client-ui-renderer, dsh-api-session-controller, dsh-api-workspace-controller, dsh-api-remotes]`。
5. 宿主单实例保护：`src\mount-once.ts:37-47`——`apply = mountOnce('@linxin666/dsh-client-ui-task-board', applyImpl)`（`src\index.ts:99`），用 `Symbol.for('dsh-web.mounted-plugins')` 全局注册表，第二个实例 apply 直接 no-op（防止重复注册路由/提示段导致启动失败）。

### 1.3 宿主侧模块划分（都在包内 `src/`，可与 `lib/index.js` 对应）

| 文件 | 作用 |
|---|---|
| `src\index.ts` | 插件入口：构造宿主服务、注册 HTTP 路由、注册系统提示段、settings 命名空间 |
| `src\host-service.ts` | 定时器（5 s 会话轮询 / 30 s cron tick）、执行启动、重启对账、电源原因 |
| `src\host-ledger.ts` | 权威账本：load/commit/lock/幂等/状态机闸门 |
| `src\host-routes.ts` | 三条 HTTP 路由 + 访问闸门 |
| `src\host-runner.ts` | 通过 typertGateway 调 session/agentPresets 真跑任务 |
| `src\protocol.ts` | wire 协议：快照结构、action 判别联合、严格校验 |
| `src\core\tasks.ts`、`core\store.ts`、`core\use-cases\*` | 领域模型与纯状态迁移 |

---

## 2. 宿主接口

### 2.1 注入的服务（`src\index.ts:30`）

```ts
export const inject = ['systemPrompt', 'typertGateway', 'workspaceRegistry', 'webServer', 'agents', 'commands']
```

### 2.2 注册的 typert 服务 / Remote 命名空间 / RPC：**无**

- 本包**不注册**任何 typert 命名空间、Remote 面或 RPC 方法。全文对 `typertGateway` 只有「消费」用法：`src\index.ts:102` 把它作为宿主服务的构造参数，`src\host-runner.ts:165-167` 用它 `gateway.invoke({ namespace, method, args, signal })`。
- 它**调用**的官方命名空间/方法（只读事实 + 执行用，注意 wire 参数名怪癖由 `src\host-runner.ts:142-146` 归一）：

  | namespace | method | 用途 | 来源行 |
  |---|---|---|---|
  | `agentPresets` | `list` | 校验 `mode`（agent 预设）存在且未 broken；args 必须为 `{}` | `host-runner.ts:143,197-200` |
  | `session` | `create` | 建执行会话（`workspaceId` / `agentPreset`） | `:213-216` |
  | `session` | `rename` | 会话标题改为任务标题 | `:219` |
  | `session` | `selectModel` | 钉住 `task.model` | `:245-249` |
  | `session` | `prompt` | 投递任务提示词（`mode: 'queue'`） | `:254-259` |
  | `session` | `list` | 会话名册：判定 running / idle 会话（复用会话） | `:265`、`host-service.ts:152,163` |
  | `session` | `follow` | 取会话历史首帧（判 `turn/end`） | `:315` |
  | `session` | `page` | 有界历史翻页 | `:337` |
  | （`commands.execute`） | — | 用 `/permission <id>` 给执行会话钉权限 | `index.ts:105-110`、`host-runner.ts:235` |

- 结论：**没有可被外部程序直接调用的宿主 RPC/服务面**。宿主对外唯一接口是 HTTP 路由（下节）。

### 2.3 HTTP 路由（唯一的对外接口）

前缀常量：`src\protocol.ts:13` → `TASK_BOARD_API_PREFIX = '/api/task-board'`。路由在 `src\host-routes.ts:122-191` 定义，由 `src\index.ts:118` 注册到 `ctx.webServer.register(route)`。

| 方法 | 路径 | 请求 | 响应 | 源码 |
|---|---|---|---|---|
| GET | `/api/task-board/state` | 无 | `TaskBoardSnapshot`（200；非 GET → 405） | `host-routes.ts:129-137` |
| POST | `/api/task-board/action` | `TaskBoardActionEnvelope`（`content-type: application/json`，否则 415） | 成功 200 + 新快照；失败 400 `{ok:false,error}`；过大 413 | `:138-160` |
| GET | `/api/task-board/events` | 无 | SSE `text/event-stream`，`data:` 帧 = `TaskBoardEventPayload`（revision/scheduler/power，**不含任务列表**），15 s `: ping` 心跳 | `:161-190` |

体积与心跳常量：`host-routes.ts:9-11`（action 64 KiB，import 2 MiB，心跳 15 s）。

**访问闸门** `isTrustedTaskBoardRequest`（`host-routes.ts:97-107`，配 `src\loopback.ts:44-63`）：

1. 必须带「浏览器同源标记」（`browserSameOriginMarker`，`host-routes.ts:65-68`）：`Sec-Fetch-Site: same-origin` **或**任意 `Origin` 头。这是 tripwire，不是权限判定。
2. 然后 `isLoopbackRequest`：socket 远端地址必须是 127/8、`::1` 或 `::ffff:127/8`（`loopback.ts:25-31`），`Host` 头主机名必须是回环（`localhost`/`[::1]`/127/8，`loopback.ts:34-37`），且 `Origin.host` 必须等于 `Host`（`loopback.ts:56-62`）。
3. 非回环（反代场景）需 `trustedProxyHosts` 白名单 + 上游注入的 `x-dsh-task-board-proxy-token`（`host-routes.ts:14`、`:105-106`；配置见 `index.ts:54-57,76-86`）。
4. 不放行 → `403 {"ok":false,"error":"forbidden"}`（`host-routes.ts:126`）。

> 实测（只读探针，未做任何写操作）：
> `GET /api/task-board/state` 无 Origin → **403**；带 `Origin: http://127.0.0.1:3080` → **200**。
> `POST /api/task-board/action` body `{}` 带 Origin 或 `Sec-Fetch-Site: same-origin` → **400 `invalid-action`**（说明闸门已过、路由在用、且空 body 不会改动账本）；无 Origin → **403**。
> `GET /api/task-board/events` → **200 `text/event-stream`**，帧内 `revision:24`、`ledgerId:ea65a6b3-6c82-4f30-9483-6db4236c8969`。

**没有任何 `/api/...` 之外的 HTTP 入口，也没有命令行入口**（包 `package.json` 无 `bin` 字段；`lib/` 下只有 `index.js`/`client.js`/`invariant.js`）。

### 2.4 写协议：action 判别联合

envelope（`src\protocol.ts:65-74`，解析器 `:235-308`）：

```jsonc
{
  "requestId": "<非空字符串，≤256>",   // 幂等键
  "action": { "kind": "...", ... },
  "initiator": "<可选的 DSH 会话 id，≤256，仅审计用，客户端自述>"   // protocol.ts:68-73
}
```
校验规则：`exactKeys` 严格白名单——多一个字段即整包拒绝（`:82-84,251`）。

| `kind` | 参数 | 语义 / 服务端闸门 | 源码 |
|---|---|---|---|
| `create` | `id`(uuid) + `input`{title,description,prompt,workspaceId?,mode?,permission?,model?,reuseSession?,schedule?{enabled,cron},freeze?,handover?} | 新任务；**status 固定为 `todo`**；id 已存在则报 `task id already exists`；`schedule.enabled` 时 cron 必须合法 | `protocol.ts:195-210,267-275`；`host-ledger.ts:491-503`；`core\tasks.ts:278-296` |
| `update` | `taskId` + `patch` | 只改「内容字段」(title/description/prompt) 与执行目标(workspaceId/mode/permission/model/reuseSession/freeze/handover)；**没有 status**；已执行过的任务内容只读；`title` 空报错 | `protocol.ts:212-225`；`core\use-cases\task-update.ts:19-23,42-44`；`host-ledger.ts:504-523` |
| `move` | `taskId` + `status` | **只允许 `backlog`/`todo`**（`MANUAL_STATUSES`）；running/已归档拒绝 | `core\tasks.ts:233,249-251`；`host-ledger.ts:532-540` |
| `delete` | `taskId` | running 任务拒绝 | `host-ledger.ts:524-531` |
| `archive` | `taskId` | 仅 `done`/`failed` 可归档 | `core\tasks.ts:176`；`host-ledger.ts:541-546` |
| `restore` | `taskId` | 从归档恢复（保留原 status） | `host-ledger.ts:547-552` |
| `set-schedule` | `taskId` + `patch`{enabled?,cron?} | 校验 5 段 cron；归档任务只读 | `host-ledger.ts:562-569`；`core\schedule.ts:69` |
| `run` | `taskId` | 真跑：起新会话（或复用空闲会话）+ 钉权限/模型 + 投递提示词；running/归档拒绝；高于会话默认权限且未确认 → `confirmation-required` | `host-ledger.ts:570-582`；`host-runner.ts:184-260` |
| `rerun` | `taskId` | 同 `run`，但先 `withStatus(task,'todo')` 重置 | `host-ledger.ts:578` |
| `confirm-permission` | `taskId` | 写 `permissionConfirmedAt`（人工确认高于会话默认的权限绑定） | `host-ledger.ts:553-561` |
| `import` | `sourceId` + `tasks[]` | **v1 迁移批量合并**：新 id 直接插入（可带任意合法 status，含 `done`）；已存在 id 按 `updatedAt` 严格更新者胜（相等则保留宿主字段），executions 按 id 合并；**剥除** `permissionConfirmedAt`；禁用字段 `args/command/executable/powershell/shell` | `protocol.ts:90-167,258-266`；`host-ledger.ts:473-490`、`mergeTask` `:230-241` |

**幂等性**：`applyRequest`（`src\host-ledger.ts:379-403`）以 `sha256(JSON.stringify(action))` 为指纹；同 `requestId` 同指纹 → 直接返回当前状态（不重复执行）；同 `requestId` 换 action → 抛 `request id was reused with a different action`。缓存上限 256（`:69`），并持久化到 `recentRequests`（`:716-721`）。

**错误面**：路由把宿主抛出的 `Error.message` 原样放进 `{ok:false,error}`（`host-routes.ts:150-157`），例如 `task not found`、`invalid manual status`、`task has already been executed`、`running task cannot be moved`、`confirmation-required: ...`、`task board is disabled`（`host-service.ts:116`）。

### 2.5 返回结构

快照 `TaskBoardSnapshot`（`src\protocol.ts:35-43`，构造 `host-service.ts:92-102`）：

```jsonc
{
  "schemaVersion": 3,
  "revision": 24,
  "tasks": [ /* TaskRecord[] */ ],
  "scheduler": { "timeZone": "Europe/Kiev", "ledgerId": "<uuid>", "lastTickAt": 1789033698463, "error"?: "…" },
  "power": { "platform": "win32", "phase": "disabled|idle|acquiring|active|error|unsupported",
             "enabled": false, "runningSessions": 1, "armedSchedules": 0,
             "sessionStateKnown": true, "lastError"?: "…" },
  "sessionDefaultPermission": "read-only"
}
```
SSE 帧 `TaskBoardEventPayload`（`protocol.ts:46-50`）只有 `revision` + `scheduler` + `power`。

### 2.6 数据模型字段含义

`TaskRecord`（`src\core\tasks.ts:98-173`）：

| 字段 | 含义 |
|---|---|
| `id` / `title` / `description` / `prompt` | uuid / 短标题 / 详情描述 / 执行时投递给 agent 的提示词 |
| `status` | `'backlog' \| 'todo' \| 'running' \| 'done' \| 'failed'`（`tasks.ts:11`，五列 = `COLUMNS` `:224-230`） |
| `createdAt` / `updatedAt` | ms epoch；`updatedAt` 也是 `import` 合并的裁决依据 |
| `executions[]` | 执行历史，最近 20 条（`EXECUTION_HISTORY_LIMIT` `:48`，`retainRecentExecutions` `:56-62`，正在跑的那条永不裁剪） |
| `executions[].id` / `sessionId` / `startedAt` / `endedAt` / `result` / `error` | 执行 id / DSH 会话 id（创建前为 undefined）/ 起止时刻 / `succeeded\|failed\|cancelled` / 失败文本（`ExecutionRecord` `:18-41`） |
| `executions[].initiatedBy` | 发起 run/rerun 的 DSH 会话 id（客户端自述，仅审计，`:31-36`） |
| `executions[].frozenAt` / `frozenBy` | 执行打开时从卡片冻结快照抄下来的溯源信息（`:37-40`） |
| `schedule` | `{enabled, cron(5 段), nextRunAt, lastTriggeredAt}`（`ScheduleRule` `:68-77`）；`nextRunAt` 由调度器维护，**不可由客户端写** |
| `workspaceId` | 执行必须在哪个工作区（workspace 列表 id）；缺省 = 最近工作区。执行前校验存在性（`host-runner.ts:191-195`） |
| `mode` | agent 预设 id（`agentPresets.list` 的 id）；缺省 = 部署默认；缺失/损坏/preset broken 会在投递提示词前失败（`host-runner.ts:196-201`） |
| `permission` | 钉在执行会话上的权限预设：`'read-only' \| 'workspace-write' \| 'danger-full-access'`（`TASK_PERMISSIONS` `tasks.ts:180`），经 `/permission <id>` 下发（`host-runner.ts:232-238`） |
| `model` | 钉的模型（`"provider/model"` 或 model id），经 `session/selectModel` 下发（`host-runner.ts:239-253`） |
| `reuseSession` | `true` 时后续执行**延续上次执行的会话**（仅当该会话仍存在且 idle），否则每次新会话（`tasks.ts:140-147`、`host-service.ts:138-139`、`session-reuse.ts`） |
| `freeze` | 续接卡片冻结快照 `{goal, progress, next, frozenAt, redacted?, frozenBy?}`（`:79-95`），存活于 wire 侧安全闸门（脱敏/斜杠污染拒绝/每字段 8 KiB） |
| `handover` | 交接包：钉住的执行三元组 (workspace/mode/permission) + 文档/脚本引用（最多 32 条、单条 512 B、合计 8 KiB），**执行时覆盖普通 pin 字段**（`core\handover.ts:35-43`、`host-runner.ts:187-189`） |
| `permissionConfirmedAt` | 人工确认时间戳；存在即视为已确认。生效权限高于 `sessionDefaultPermission` 且无此戳 → 手动 run 被拒、cron 跳过该卡片转下一次（`core\handover.ts:98-116`、`host-ledger.ts:408-415,575-577`） |
| `archivedAt` | 归档时刻；归档任务离开主看板、只读、不可执行，直到 restore |

盘上文档另含 `scheduler`（含仅落盘的 `importedSources[]`，`host-ledger.ts:17-19,483`）与 `recentRequests[]`（`:21-24`，幂等缓存，用途见 2.4）。

`status` 取值来源（这是「能否手改状态」的核心）：

- `create` → 恒为 `todo`（`core\tasks.ts:284`）。
- 手动迁移：只有 `backlog`/`todo`（`MANUAL_STATUSES` `tasks.ts:233`）。
- `running`：`startExecution` 打开执行时写入（`:332-362`）。
- `done`/`failed`：`settleExecution` 结算时写入（`:369-388`）——`succeeded` → `done`（**若 `schedule.enabled` 则为 `todo`**，因为还要继续跑）；`failed` → `failed`；`cancelled` → 回 `todo`。
- 结算触发者：`host-service.pollSessions`（5 s）→ `reconcileExecutions` → `runner.inspect`（判 `turn/end` 是否 error）→ `ledger.settle`（`host-service.ts:149-192`、`host-runner.ts:285-370`）。

### 2.7 宿主配置（composition / settings 命名空间 `task-board`）

`src\index.ts:40` 定义命名空间 `'task-board'`；schema `:66-73`：

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 开关（宿主服务 + 浏览器看板） |
| `announceToAgent` | **`false`** | 是否把 `plugin:task-board` 系统提示段注入所有 agent 提示词 |
| `preventIdleSleep` | `false` | 空闲系统睡眠保护（可选） |
| `trustedProxyHosts` | `[]` | 反代白名单 |
| `proxyTokenEnv` | `DSH_TASK_BOARD_PROXY_TOKEN` | 反代 token 的环境变量名（`index.ts:28`） |
| `sessionDefaultPermission` | `read-only` | 权限确认闸门的基准（`core\handover.ts:44`） |

系统提示段：`ctx.systemPrompt.section({ name: 'plugin:task-board', order: 200, text: TASK_BOARD_GUIDANCE })`（`index.ts:147-151`，文案 `:33`，`SECTION_ORDER = 200` `:25`）。

> 本机现状：`C:\Users\lai\.dsh\settings.yaml` 只有 `ui-onboarding` / `dsh-backup` / `pet` 三节，**没有 `task-board` 节**；profile 的 `cordis.patch.yml` 为 `[]`、bundle 行未给 task-board 传 config → 全部取 schema 默认值，即 **`announceToAgent=false`：当前 agent 的系统提示里没有看板提示段**。

---

## 3. 前端接口

### 3.1 客户端注入的服务（`src\client\index.ts:83`）

```ts
export const inject = ['slots', 'sessions', 'workspaces', 'connection', 'settingsScope', 'locale', 'remote']
```

### 3.2 注册的 slot：只有一个

| slot 名 | 注册物 | 说明 | 源码 |
|---|---|---|---|
| `web-ui.plugin.item` | `TaskBoardSettingsCard`（id `task-board`，order 110） | 设置面板里的插件配置卡片（读写 `task-board` 命名空间）。`src\client\index.ts:46-55` 自行 `declare module` 声明该 slot 形状（避免依赖同族 UI 包），`:171-187` 用 `ctx.slots.inject(...)` + `ctx.slots.register({...})` 注册 | `client\index.ts:171-187` |

`locale` 命名空间 `'task-board'`（`client\index.ts:35`，词典 `client\locales.ts`）。除此之外**没有**注册任何别的 slot。

### 3.3 左侧栏「任务看板」入口是**怎么挂上的**：DOM 注入，不是 slot

源码注释明说 DSH 侧栏 shell 没有可注册的 slot（`sidebar.workspaces` / `sidebar.settings` 是单占位且已被占用），所以走 DOM 注入：

- 包装层 `src\client\sidebar-entry.ts:36-52`：`rowAttribute: 'data-dsh-taskboard-entry'`、行选择器 `[data-dsh-taskboard-entry]`、`plugin: 'task-board'`（输出 `data-dsh-plugin`/`data-dsh-part="sidebar-entry"`）、`position: 'before'`、`familySelectors: ['[data-dsh-taskboard-entry]','[data-dsh-ssh-entry]']`、点击 → `controller.toggleBoard()`。
- 共用核心（生成副本）`src\client\sidebar-entry-core.ts`：
  - 找侧栏根：`[data-pane="sidebar"], [class*="sidebarCol"]`（`:67`），优先 `[class*="logoRow"]` 的父元素（`:72`）。
  - 锚点：`button[class*="newSession"]`（`:78`），即插在「新会话」按钮之后、工作区浏览区之前（`:113-133`）。
  - 自愈：`MutationObserver` 盯侧栏根与 `document.body`，React 重渲染把行挤掉时同帧重插（`:196-210`）；DOM 级幂等：已存在同行属性则直接返回（`:148-150`）。
- 打开状态高亮：`entry.dataset.active`（`:215-223`）。

> 也就是说：用户看到的「任务看板」一级入口由**本插件自己注入**，而不是 `dsh-better-sidebar` 或其它社区插件渲染的（对 `dsh-better-sidebar\lib` 全文 grep `taskboard|task-board|taskBoard` **无匹配**）。

### 3.4 看板主体视图：中央列 DOM 接管

`src\client\board-mount.tsx:18,29-42` + 共用核心 `src\client\panel-mount-core.ts`：

- 容器注入到中央列 `[data-pane="conversation"], [class*="centerCol"]`（`panel-mount-core.ts:52,62-64`），属性 `data-dsh-taskboard-view`；激活时在 `<html>` 上置 `data-dsh-taskboard-active`，并由 CSS 隐藏会话内容（不动 React 树，会话状态保留）。
- 与兄弟面板互斥：跨插件事件 `dsh-panel-activate`（`:54`），兄弟属性 `data-dsh-ssh-active`（`board-mount.tsx:35-37`）。
- 点侧栏会话/工作区/搜索行会收起面板（capture 阶段，`:59`）。

### 3.5 客户端调用的「RPC」：不是 typert remote，而是同源 `fetch`

`src\client\host-api.ts:32-104`（`HttpTaskBoardHostTransport`）：

- `GET /api/task-board/state`（`:57`）、`POST /api/task-board/action`（`:66-70`，body = envelope，15 s 超时 `:13,73-84`）、`EventSource('/api/task-board/events')`（`:87`）+ `visibilitychange` 触发全量刷新（`:97-98`）。
- 首次加载的 v1 数据迁移：读 `localStorage['dsh.taskBoard.v1']`，若非空且标记 `dsh.taskBoard.v2.hostImported` ≠ 当前 `ledgerId`，则发一次 `import`（`host-api.ts:10-12,35-54`）。**`import` 因此是浏览器首次迁移的正常路径**，也是唯一能带任意 status 的 action。

其它只读运行时事实（非账本）：`remote.agentPresets.list()` / `connection.api.agentPresets.list`（`client\index.ts:103-131`）、`connection.api.llm.discoverModels` / `connection.api.sessions.modelCatalog`（`:252-284`）、`workspaces.list`（`:222-232`）、`sessions.list/open`（`:208-212`）。

### 3.6 UI 动作 → action 映射（`src\core\controller.ts`）

| 控制器方法 | 发出 action | 行 |
|---|---|---|
| `createTaskConfirmed` | `create` | `:278` |
| `updateTask` | `update` | `:293` |
| `moveTask` | `move` | `:311` |
| `deleteTask` | `delete` | `:320` |
| `archiveTask` / `restoreTask` | `archive` / `restore` | `:339` / `:352` |
| `setSchedule` | `set-schedule` | `:378` |
| `runTask` / `rerunTask` | `run` / `rerun`（带 `initiator` = 当前会话 id） | `:426` / `:451` |
| `confirmPermission` | `confirm-permission` | `:443` |

客户端侧 revision 防回退：同一 `ledgerId` 下，`snapshot.revision < 当前` 的快照被丢弃（`controller.ts:572-589`，判断点 `:576`）。

UI 能做的状态变更（证据）：拖拽落点只对 `backlog`/`todo` 列生效（`client\board\TaskBoard.tsx:129,140-148`）；任务详情里「移动到」只渲染 `MANUAL_STATUSES`（`client\board\TaskDetail.tsx:404-414`）；主按钮是 Run/Rerun（`:443-456`）；归档按钮仅在 `done`/`failed` 时出现（`:469-480`）。**没有任何按钮把任务直接标成「已完成」。**

---

## 4. 并发与权威性

### 4.1 `revision` 的作用

- 由宿主在 `commit()` 时 `+1`（`src\host-ledger.ts:760-761`），**单调递增**；启动时 `commit(false)` 不 bump（`:299`）。读取：快照 `host-service.ts:96`、SSE 帧 `:106`。
- 用途：(a) 变更通知/对账（客户端拿它决定是否重新拉全量，`controller.ts:544-553`）；(b) 客户端防陈旧快照回退（`:576`）；(c) 人类可读的「账本世代内计数」。
- **它不承担并发控制**：action envelope 里没有 `revision`/`If-Match`/版本前置条件，宿主也不比较磁盘文件里的 revision 与内存值。所以丢更新（lost update）保护只对「带 requestId 的 API 动作」成立，对**文件级外部写入不成立**。

### 4.2 `ledger-v2.lock` 的语义

`HostTaskLedger.acquireLock()`（`src\host-ledger.ts:791-852`）：

- 语义：**同一 `$DSH_HOME/task-board` 目录，同一时刻只允许一个宿主进程写账本**。用 `openSync(lockFile, 'wx', 0o600)` 原子独占创建（`:794`）。
- 记录内容（本机实测）：`{"pid":29184,"token":"bcf53af2-…","startedAt":1789029219580,"probe":"exact"}`（`:801`）。
- 抢锁判定：`EEXIST` → 读 pid/startedAt/probe → `processIsAlive` 与**进程启动时间比对**（Linux `/proc`、Windows PowerShell 取 StartTime，`:147-197`）区分「真占用」与「PID 复用/崩溃残留」；真占用则抛 `task-board ledger is already owned by process <pid>`，判定为残留则 unlink 后重试（`:806-849`）。锁文件不可读则 fail-closed 并提示人工删除（`:816-820`）。
- 释放：`dispose()` 时仅当文件里的 `token` 仍等于自己才 unlink（`:366-377`）。

### 4.3 谁在什么时候写文件（这是「回滚」的根因）

`commit()`（`src\host-ledger.ts:760-785`）的做法：`revision += 1` → 写 `${file}.tmp-<pid>`（0600）→ `fsync` → `renameSync` 覆盖 → 再 fsync 目录（Windows 上目录 fsync 失败被容忍）→ 通知订阅者。**整篇文档覆盖写**，不是增量。

`commit` 调用点：

| 时机 | 源码 |
|---|---|
| 构造/启动（`commit(false)`：写入迁移后的任务、新 `ledgerId`、恢复错误） | `host-ledger.ts:289-303` |
| 每个被接受的 action（含 `create/update/move/delete/archive/restore/set-schedule/run/rerun/confirm-permission/import`） | `:584` |
| cron 触发（`openScheduled`：滚动 `nextRunAt` 或开新执行） | `:405-426` |
| 重启/长时间停顿后的错过触发点处理（`skipMissed`） | `:428-437` |
| cron 表达式修复 `repairSchedules`、重启对账 `reconcileInterruptedStarts` | `:588-619` |
| 执行会话挂载 `attachSession`、执行结算 `settle`（5 s 轮询里发生） | `:452-467`、`host-service.ts:174,187` |
| `setScheduler` 且 patch 含 `lastTickAt` 之外字段 | `:439-449` |

另有一条**不写主账本**的路径：30 s cron tick 只把 `lastTickAt` 写进 sidecar `scheduler-v2.json`（`host-ledger.ts:445-448,733-758`，常量 `host-service.ts:11`）。所以「文件被改」不是因为每 30 s 的 tick，而是**下一次真正的 commit**——这与「约 1 分钟后被回滚」一致：任意一次看板操作、执行结算或重启恢复都会触发 commit，用内存里的文档整体覆盖磁盘。

### 4.4 为什么外部直接改文件会被覆盖（明确结论）

1. `HostTaskLedger` 只在**进程启动时**读一次文件（`load()` `:634-659`），之后所有读写都发生在内存 `this.document` 上；**没有任何代码在运行期重新读盘或与磁盘做三方合并**。
2. 因此外部把文件改成 `status: done` 或追加任务：
   - 运行中的宿主**看不到**这些改动（内存不变，快照/SSE 都不会反映）；
   - 下一次 `commit()` 用内存文档整体 `rename` 覆盖该文件 → 外部改动丢失，`revision` 也被内存值接管。
3. 反向也成立（本机实测，见 §5.3）：磁盘当前的 revision/任务数与宿主内存不一致，说明磁盘上有一份宿主从未见过的写入，它会在下一次 commit 时被丢弃。
4. 与官方 API 路径的差别：API 动作有严格字段白名单、状态机/权限闸门、`requestId` 幂等、以及「内存即真相」的原子提交；文件级写入绕过全部这些，且不触发任何通知。

### 4.5 受支持的写入口（问题 4 的正面回答）

**唯一受支持的外部写入口**：`POST /api/task-board/action`
（约束：来自回环 socket + 回环 `Host` + 浏览器同源标记；`content-type: application/json`；普通动作 ≤64 KiB、`import` ≤2 MiB；建议每次用新的 `requestId`，重试沿用同一 `requestId` 以获得幂等。）

用它**能**做到：新增任务（status 恒为 `todo`）、改标题/描述/提示词/工作区/预设/权限/模型/会话复用、改 cron、在 `backlog`↔`todo` 之间移动、归档/恢复、删除、确认权限、`run`/`rerun` 触发真实执行。

用它**不能**做到：把**既有**任务的 `status` 直接写成 `done`/`failed`（`move` 的目标域只有 `backlog`/`todo`；`update` 无 `status` 字段）。

**唯一的例外/旁路**：`import`（`kind: 'import'`）
- 对**新 id**：可以插入任意合法 `status`（含 `done`）的完整任务记录（需通过 `parseLedger` 结构校验，`core\store.ts:156-196`，必填 `id/title/description/prompt/status/createdAt/updatedAt/executions`）。
- 对**已存在 id**：只有当导入记录的 `updatedAt` **严格大于**宿主现有值时，其顶层字段（含 `status`）才覆盖宿主值；相等则保留宿主字段（`mergeTask` `host-ledger.ts:230-241`；README 同述）。
- 注意：`sourceId` 对同一账本世代只能成功一次（`importedSources` 去重，`host-ledger.ts:474-475,483`）；且该路径会**剥除** `permissionConfirmedAt`（`protocol.ts:164-166`）。
- 该 action 的设计用途是「浏览器 v1 → v2 迁移」，README 并未把它声明为公开的外部写接口 → 结论标为「**可用，但属未公开契约的旁路**」。

**因此：`done` 的「官方」产生方式只有真实执行（`run`/`rerun` → 真实 DSH 会话 → `turn/end` 非 error → `settleExecution` → `done`）**；若任务有启用中的 cron，成功后会回到 `todo` 以便下次继续跑（`core\tasks.ts:383-387`）。

---

## 5. agent 视角（问题 5）

### 5.1 明确结论：**没有**

在本机安装的 `@linxin666/dsh-client-ui-task-board@0.3.18` 中：

- 不注册任何 agent 工具：对 `lib\index.js` 全文检索 `registerTool|defineTool|ctx.tools|.command(` **零匹配**；`src/` 中亦无工具/命令注册代码（唯一用到 `commands` 服务的地方是 `ctx.commands.execute(agent, '/permission <id>')`，即**替执行会话下达**斜杠命令，不是注册命令）。
- 不注册斜杠命令（无 `ctx.commands.register`）。
- 不注册 typert/RPC 面（见 2.2）→ agent 也无法通过 remote 调用。
- 无 CLI（`package.json` 无 `bin`；`dsh plugin ...` 只是 DSH 自己的插件管理命令）。
- 唯一的 agent 可见接触面是系统提示段 `plugin:task-board`（`index.ts:147-151`，文案 `:33`），但 `announceToAgent` **默认 `false`**（`index.ts:67`、README `:60`），本机 `settings.yaml` 无 `task-board` 节 → **该段当前未注册**，agent 连「本机有这个看板」都不会从提示词里得知。

### 5.2 唯一可行的人工路径

1. **UI 操作**（用户）：在左侧栏「任务看板」里新建/编辑/拖拽（`backlog`↔`todo`）、Run/Rerun、归档/恢复/删除、确认权限。**UI 也无法把任务直接标为「已完成」。**
2. **agent/外部程序用 HTTP**：agent 可以自己用 `pwsh`（`Invoke-RestMethod`/`curl.exe`）调 §4.5 的接口，因为这等价于「本机程序调用受支持的写入口」：
   ```powershell
   # 读
   Invoke-RestMethod -Uri 'http://127.0.0.1:3080/api/task-board/state' -Headers @{ Origin = 'http://127.0.0.1:3080' }
   # 写（示例：新增任务，status 必为 todo）
   Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3080/api/task-board/action' `
     -Headers @{ Origin = 'http://127.0.0.1:3080' } -ContentType 'application/json' `
     -Body '{"requestId":"<uuid>","action":{"kind":"create","id":"<uuid>","input":{"title":"t","description":"d","prompt":"p"}}}'
   # 写成 done：只能走 import 旁路（新 id 或更新的 updatedAt），或 run 真跑一次
   ```
   端口来自运行环境变量 `DSH_WEB_URL=http://127.0.0.1:3080`。**注意**：这不是「agent 工具」，需要 agent 自行拼 HTTP；且 `Origin` 头必须与 `Host` 同源，否则 403。

---

## 6. skill 的发现与注册机制（第二部分）

### 6.1 两个包分工（DSH 0.1.2-rc.1，均已在 `dsh-base` bundle 装载）

`C:\Users\lai\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml:279-290`：

```yaml
- id: skill            → @deepseek-ai/dsh-skill
- id: skill-filesystem → @deepseek-ai/dsh-skill-filesystem
- id: skill-badge      → @deepseek-ai/dsh-skill-badge
- id: tool-skill       → @deepseek-ai/dsh-tool-skill
```

- `@deepseek-ai/dsh-skill`：注册表（服务名 **`ctx.skills`**，`...\dsh-skill\lib\types\index.d.ts:201-204` 的 `declare module '@deepseek-ai/cordis' { interface Context { skills: SkillRegistry } }`）。它自己不含任何 skill 内容。
- `@deepseek-ai/dsh-skill-filesystem`：**本地磁盘 provider**（默认 provider 名 `filesystem`）。
- `@deepseek-ai/dsh-tool-skill`：把目录渲染进会话（模型侧 `skill` 工具与人工可调用的目录消费方）。

### 6.2 磁盘发现规则（`dsh-skill-filesystem\README.md:34-54`）

- 形状：`<name>/SKILL.md` 目录包，或根下平铺的 `<name>.md`；**只扫一层**（嵌套 `**/SKILL.md` 不发现）。
- frontmatter（YAML）：必填 `name`（kebab-case）、`description`；可选 `whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`（严格布尔语法，非法拼写 → 整条 skill 被丢弃并告警）。
- 根目录与优先级（rank 小者胜）：

  | rank | 来源 | 路径 |
  |---|---|---|
  | 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
  | 200 | `project-agents` | `<projectRoot>/.agents/skills` |
  | 300 | `custom` | `Config.customSkillDirs` |
  | 400 | `user-dsh` | `<dshHome>/skills`（跳过其 `.system` 子目录） |
  | 500 | `user-agents` | `<agentsHome>/skills` |
  | 600 | `bundled` | `bundledSkillDir`（配置时才扫） |

  `<projectRoot>` = 最近的含 `.git` 的祖先目录。
- 配置项：`providerName`(=filesystem)、`includeDefaultRoots`(=true)、`dshHome`、`agentsHome`、`customSkillDirs`、`watch`(=true)、`bundledSkillDir` 及一组 `watch*`（README `:65-75`）。
- 动态性：`watch: true` 时用 Chokidar 盯根目录（depth 1），新增/改名/删除/改 frontmatter 会触发失效；正文编辑每次加载都重读文件，无需版本号（README `:36-40,:79`）。
- 本机现状：`C:\Users\lai\.dsh` 下**没有 `skills` 目录**（该目录列表只有 `.agent-presets/ profiles/ sessions/ storages/ task-board/ dsh-session-archive/ dsh-usage/` 与若干文件），环境变量也没有 `DSH_BUNDLED_SKILL_DIR`（只有 `DSH_HOME=C:\Users\lai\.dsh`、`DSH_WEB_URL` 等）→ 本机的 user-dsh root 为空，实际 skill 只能来自项目根（如 `C:\Users\lai\Documents\GitHub\dsh\dsh-personal-workflow\skills\`）或其它配置的 root。

### 6.3 可编程注册接口（宿主插件「装载即注入、卸载即移除」）

两条官方路径，都是同步注册、返回 **Cordis fiber 级 disposer**（fiber 释放即自动反注册）：

1. **内嵌/runtime skill**（插件把自己的 SKILL 内容挂进目录，最贴合「装载即注入」诉求）
   ```ts
   // dsh-skill\lib\types\index.d.ts:259
   register(skill: SkillRegistration): () => void
   // SkillRegistration = Omit<SkillDefinition,'invocation'|'provider'> & { invocation?, provider? }   (d.ts:80-86)
   // 即 { name, description, content, whenToUse?, resourceBase?, metadata?, path?, invocation?, provider? }
   ```
   - `invocation` 缺省表示「模型与用户两个面都允许」（d.ts:82-83）；provider 缺省用注册表保留名 `runtime`（README `:52`；`runtime` 是保留 provider 名，README `:53`）。
   - 同一 layer 内同名 runtime skill 为**先到先得**，重复者得到 no-op disposer（d.ts:252-255）。
   - 层级与优先级：注册进入**调用上下文的 layer**（宿主/仓库插件 → 全局层；被 agent preset 的常驻组合挂载的插件 → 该 preset 的 layer）；跨层读取时**近层同名直接胜出**，同层内按 rank（项目 > runtime > 用户）→ provider 注册顺序 → provider 内顺序（README `:82`、d.ts:250-255）。
2. **自定义 provider**（skill 来自非磁盘来源，如远端/数据库/包内嵌数据）
   ```ts
   // dsh-skill\lib\types\index.d.ts:249
   registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void
   // SkillProvider = { name, list(options) , get(candidate, options) }        (d.ts:167-188)
   // control = { signal: AbortSignal, invalidate: () => void }                (d.ts:189-195)
   ```
   - 内部数据变化时由 provider 自己调 `control.invalidate()`（注册表**没有 TTL**，失效是 provider 驱动的，README `:101,:136`）。
   - `name` 在同层重复或使用保留名会 throw（d.ts:242-244）。

宿主插件用法要点：`inject` 里加上 `'skills'`（或用 `ctx.inject(['skills'], …)`），在 `apply()` 中同步 `ctx.skills.register({...})` 并 `ctx.effect(() => dispose)`（或直接返回该 disposer），插件卸载/dispose 时该 skill 即从目录消失；无需改 DSH 源码、无需重启（注册表失效会 bump revision 并广播 `skills/change`，消费方在下一模型步重取目录，README `:101`）。

---

## 7. 复现证据清单

### 7.1 只读 HTTP 探针（本机，运行中的宿主 PID 29184，`http://127.0.0.1:3080`）

```
GET  /api/task-board/state                  (无 Origin)                 → 403 {"ok":false,"error":"forbidden"}
GET  /api/task-board/state                  (Origin: http://127.0.0.1:3080)
   → 200 {schemaVersion:3, revision:24, tasks:7, ledgerId:ea65a6b3-…, sessionDefaultPermission:"read-only"}
POST /api/task-board/action  body={}        (无 Origin)                 → 403 forbidden
POST /api/task-board/action  body={}        (Origin 同源)               → 400 {"ok":false,"error":"invalid-action"}
POST /api/task-board/action  body={}        (Sec-Fetch-Site: same-origin)→ 400 invalid-action
GET  /api/task-board/events (Origin 同源)   → 200 text/event-stream  data:{"revision":24,...,"power":{...,"runningSessions":1,...}}
```

> 说明：`POST {}` 在协议解析阶段即被拒（`host-routes.ts:149-150`），**不会触发任何账本写入**；本次调研未发出任何有效 action，未修改 `~/.dsh` 下任何文件。

### 7.2 进程/文件事实

```
Get-CimInstance Win32_Process -Filter "Name='node.exe'"
  PID 29184  11:33:39  node ...\@deepseek-ai\dsh\lib\bin.js web        ← 宿主（唯一）
  PID 10516  11:33:44  ...\@linxin666\dsh-doctor\lib\cli.mjs supervisor --parent-pid 29184
C:\Users\lai\.dsh\task-board\ledger-v2.lock
  {"pid":29184,"token":"bcf53af2-cd49-4a66-a5e6-a74dd0e9d94a","startedAt":1789029219580,"probe":"exact"}
C:\Users\lai\.dsh\task-board\scheduler-v2.json
  {"lastTickAt":1789033578439}   ← 持续前进（30 s tick 只写 sidecar）
```

### 7.3 「磁盘 ≠ 内存」现场（外部写入会被丢弃的实证）

| 视图 | revision | 任务数 | 任务 id |
|---|---|---|---|
| 运行中宿主内存（`GET /state`） | **24** | **7** | cb29c79d, 3ada2a59, c9f79510, b647da26, 2894cacf, e97d9e23, e819f9ee |
| 磁盘 `ledger-v2.json`（mtime 12:33:20.570） | **25** | **9** | 上述 7 条 + `963b28f4`、`123dcc85`（两条均 `todo`，`createdAt=1789032800373` ⇒ 12:33:20.373） |
| `ledger-v2.json.bak-2026-09-10T09-33-20-566Z`（12:33:20.566） | 24 | 7 | 与宿主内存完全一致 |
| `ledger-v2.json.bak-2026-09-10T08-42-49-833Z` | 23 | 6 | 上述前 6 条 |

- 该 `.bak-*` 命名**不是本插件产生的**（包内 grep `bak-|\.bak` 无匹配；插件的损坏隔离名是 `ledger-v2.json.corrupt-*`，`host-ledger.ts:705`）→ 由外部脚本/工具产生（推断；具体脚本**未证实**）。
- 结论：磁盘上这份 rev 25 / 9 任务是宿主内存从未见过的写入（多出的两条任务在看板里不会出现），它会在宿主下一次 `commit()` 时被整体覆盖。

### 7.4 关键代码位置（引用汇总）

| 主题 | 位置 |
|---|---|
| 插件入口 / 服务注入 / 路由注册 / 提示段 | `src\index.ts:30,99,102,113,118,147-151` |
| 配置 schema 与默认值 | `src\index.ts:66-73` |
| API 前缀 / 快照 / action 联合 / envelope | `src\protocol.ts:13,35-43,52-63,65-74,235-308` |
| 三条 HTTP 路由 + 闸门 + 限额 | `src\host-routes.ts:9-11,65-68,97-107,122-191` |
| 回环判定 | `src\loopback.ts:25-31,34-37,44-63` |
| 账本文件/锁路径、commit、锁 | `src\host-ledger.ts:283-289,760-785,791-852` |
| 幂等（requestId/指纹/256 条） | `src\host-ledger.ts:69,379-403,716-721` |
| 各 action 闸门（move/run/import…） | `src\host-ledger.ts:469-586` |
| status 域、手动域、结算规则、20 条历史上限 | `src\core\tasks.ts:11,48,56-62,224-241,249-251,278-296,332-388` |
| 磁盘文档解析/字段修复 | `src\core\store.ts:156-196` |
| 执行：建会话/钉权限/钉模型/投递/结果判定 | `src\host-runner.ts:142-146,184-260,262-282,285-370` |
| 5 s 轮询 / 30 s tick / 结算 | `src\host-service.ts:10-12,63-70,149-209` |
| 客户端 slot 注册 / 侧栏注入 / 视图接管 | `src\client\index.ts:83,171-187`；`src\client\sidebar-entry.ts:20-52`；`src\client\sidebar-entry-core.ts:66-74,113-133,148-150,196-210`；`src\client\board-mount.tsx:18,29-42`；`src\client\panel-mount-core.ts:52,62-64` |
| 客户端传输（fetch/SSE/import 迁移） | `src\client\host-api.ts:10-13,32-104` |
| 控制器 → action 映射 + revision 防回退 | `src\core\controller.ts:278-451,544-589` |
| UI 只能拖到 backlog/todo | `src\client\board\TaskBoard.tsx:129,140-148`；`src\client\board\TaskDetail.tsx:404-414,443-480` |
| skill 注册 API | `...\dsh-skill\lib\types\index.d.ts:80-86,167-195,201-204,227-286`；`...\dsh-skill\README.md:48-66,93-101` |
| skill 磁盘发现 | `...\dsh-skill-filesystem\README.md:34-54,65-79` |
| bundle 装载行 | `...\dsh-web-all\cordis.patch.yml`（`web-ui-task-board` 行）；`...\dsh-web-all\lib\shell.js:104`；`...\dsh-base\cordis.patch.yml:279-290` |

---

## 8. 未解问题 / 未证实项

1. **磁盘上 `963b28f4`、`123dcc85` 的来源未证实**：从 `createdAt`(12:33:20.373) 与外部 `.bak`(12:33:20.566) / 主文件写入(12:33:20.570) 的 197 ms/4 ms 间隔看，像是某个外部脚本「先备份、再写新版文档」；具体是哪个脚本、是否由用户手改或由上位 agent 生成，无法从现有证据判定。
2. **`import` 作为公开外部写入口未经上游声明**：README 只把它描述为 v1→v2 迁移路径（`:74`）。是否会被上游视为「受支持的外部写 API」需向作者确认；本文件按「可用但未公开契约」标注。
3. **`GET /state` 与 `POST /action` 的并发语义**：未见 action 前置 revision/ETag 校验；若多个外部写者并发 POST，最终以宿主串行处理顺序为准（宿主单线程串行，`commit` 全覆盖）。是否存在竞态窗口未逐条验证。
4. **反代路径（`trustedProxyHosts` + `X-Dsh-Task-Board-Proxy-Token`）未实测**，仅按代码与 README `:66` 记录。
5. **上游是否有更新版本提供 agent 工具或 CLI** 未查（本机为 0.3.18；未访问 npm 查询更新）。
6. **`import` 路径是否绕过全部状态机闸门**：已确认它不经过 `canEditTaskContent`（只有 `update` 走该闸门）、且会剥除 `permissionConfirmedAt`；对「导入 running 状态、导入带未确认高权限」等对抗场景未逐条试验。
7. **宿主提示段是否真的未注入本机 agent**：结论由「schema 默认 `announceToAgent=false` + 本机 `settings.yaml` 无 `task-board` 节 + profile patch 为空」推出（间接证据），未直接 dump 运行中 agent 的系统提示做对照。
