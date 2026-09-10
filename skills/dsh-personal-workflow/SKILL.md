---
name: dsh-personal-workflow
description: laituli 个人仓插件的开发工作流——开发/验证/备份/部署/发布/复现的固定动作，以及「宿主改动=冷重启、客户端改动=F5」的生效判定。做 dsh / dsh 插件开发、部署、发布、回滚或灾时恢复时使用。
---

# 个人仓插件的开发工作流

> 由 `dsh-personal-workflow` 插件热注入；插件卸载后本 skill 消失。

## 铁律（先看生效方式）

1. **宿主侧代码只在启动时装配**：改 `lib/index.js`、改 profile 的 dependencies/bundles（安装或升级插件）→ **必须冷重启宿主**。
2. **客户端产物随页面加载**：只改 `lib/client.js`（由 `src/*` 构建）→ **Ctrl+F5 即可**。
   `patchReload: live` 只对补丁配置生效，不会热换插件 JS。

## 验证五件套（全绿才往下走）

```powershell
node --check lib\index.js
node scripts\build-client.mjs
node scripts\smoke-client.mjs
node scripts\smoke-settings.mjs
node scripts\smoke.mjs
node scripts\e2e-restore-headless.mjs   # 免 LLM 的隔离端到端（按仓内实际脚本名）
```

- 断言要跟着入口迁移更新（例：`stop` 从 `rescue.mjs` 迁到 `ops.mjs` 后，E2E 断言的路径同步改），否则会出现“代码对了、测试红了”的假失败。
- 判断“是不是我引入的回归”：在**未改动的 HEAD** 上用 `git stash` 跑同一套测试做 A/B 基线。

## 主流程：开发 → 验证 → 备份 → 重新部署 → 验证 → 发布 → 重新部署

1. **开发**：能放客户端的别放宿主（省一次冷重启）；能放进程外脚本的也别放宿主；上游文件保持原样，fork 增量放独立文件并标注。
2. **验证**：见上“验证五件套”。
3. **备份**：部署前用插件自身备份一次（产出可整包回滚的归档，并刷新备份目录里的冷启动救援资产）。
4. **重新部署（内环）**：`build-client` → 对齐宿主实际加载的位置（开发期可用 store 覆盖，**临时手段**）→ 冷重启。
   **重新部署（正式）**：`npm pack` → `dsh plugin --profile <p> add <tarball 绝对路径>` → 冷重启。
5. **验证（部署后）**：Ctrl+F5 → 逐项点 UI；再用部署后的产物跑能自动化的部分；结论记入任务看板。
6. **发布**：版本号 +1 → 文档补齐 → **推送提交**（灾时要从 git 取最新）→ 打 tag → Release。
7. **重新部署（从发布物）**：改从发布物安装 → 冷重启 → 复验，证明“任意机器可从发布物复现”。

## 可复制的成对重启指令（跨平台要点）

- 先停旧宿主：`node "<备份目录>/ops.mjs" stop --web-port <端口>`（幂等；没在跑就跳过）
- 再启新宿主：宿主自身启动命令原样复现（含 profile）；**Windows/PowerShell 以引号开头的可执行文件要用 `&` 调用**
- 自定义 `DSH_HOME` / 非默认 cwd 启动的宿主：重启指令必须带上 `$env:DSH_HOME='…'` 与 `Set-Location '<cwd>'`，否则新宿主会去读默认 `~/.dsh`（看起来像“恢复完什么都没了”）。

## 灾与恢复（要点）

- 恢复的三条路径：面板恢复（宿主活着）/ 部署期恢复（需要停机窗口）/ 救援通道（宿主起不来）。
- **硬前提**：备份归档与目标 `DSH_HOME` 的**末级目录名必须一致**（默认都是 `.dsh`），不一致会被安全校验拒绝。
- `profiles/*/node_modules` 不进归档：先重装依赖，再启动 —— 顺序不能反。
- **冷启动救援资产是快照**：备份时才把 `rescue.mjs` / 启动器写进备份目录；**升级后要做一次备份**，灾时用的才是新代码（Windows 上 `copyFile` 保留源文件时间，比内容/哈希，不比时间戳）。

## 坑（踩过的）

1. **Windows 句柄**：恢复/改名整个数据目录前，先关掉自己持有的日志句柄并等端口释放，否则 `EPERM`。
2. **自解释失败**：把底层英文错误翻译成“原因 + 下一步”，不要暴露 `exit=128: fatal: ...`。
3. **任务看板**：`~/.dsh/task-board/ledger-v2.json` 的权威状态在插件进程内，**外部直接改会被回写覆盖**；受支持的更新途径见 `docs/taskboard-interface.md`（无则只能 UI 操作）。

## 任务看板（task-board）

实现包：`@linxin666/dsh-client-ui-task-board@0.3.18`（宿主 `lib/index.js`，客户端 `lib/client.js`）。
宿主**没有 RPC、没有 CLI、没有 agent 工具**；唯一对外面是三条 HTTP（需回环 + 同源 `Origin`）：

- `GET  /api/task-board/state` —— 读账本
- `POST /api/task-board/action` —— 唯一受支持的外部**写**入口（envelope: requestId/action/initiator；requestId+sha256 指纹幂等）
- `GET  /api/task-board/events` —— SSE 事件流

### 硬结论：没有受支持的方式把任务标成 done

- `move` 的目标域只有 `backlog` / `todo`；`update` 的 patch 不含 status；`create` 恒为 todo；
- `done` / `failed` **只能由真实执行结算（settleExecution）产生**；UI 也标不了；
- 唯一能直接写 done 的是 `import`（v1 迁移旁路，**未公开契约**）——不要据此写自动化。

### 不要直接改 `~/.dsh/task-board/ledger-v2.json`

宿主**只在启动时读盘一次**，之后内存为权威；任何一次 commit（action、cron、5s 轮询结算、调度修复）都会原子覆盖整个文件，**没有 revision 校验/合并**。
实测：宿主内存 rev24/7 任务 vs 磁盘 rev25/9 任务 → 磁盘那份会被下次 commit 丢弃。
（`revision` 只用于通知与客户端防回退；`ledger-v2.lock` 是单写者独占锁。）

### agent 能做什么

- **没有工具、没有斜杠命令**（明确结论）；系统提示里的 `plugin:task-board` 段受 `announceToAgent` 控制，默认 false；
- 因此：进度跟踪要么由**真实执行**驱动（跑任务 → 结算），要么**由人用 UI**操作；
- 需要程序化读取时，可自备 HTTP：`GET $env:DSH_WEB_URL/api/task-board/state`，并带上 `Origin: $env:DSH_WEB_URL`。
