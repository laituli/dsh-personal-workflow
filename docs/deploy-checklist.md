# 部署清单（URL#tag 形态；跨机器冷启动规范）

> 规范：**安装源必须是可跨机器解析的 git URL**（`https://github.com/<owner>/<repo>.git#<tag>`），
> 插件位于子目录时再追加 `&path:/<sub/dir>`。本地 `%TEMP%` 里的 tarball **只能作为离线兜底**，
> 因为它换一台机器就不存在，不符合冷启动要求。

## 0. 目标产物与对应 tag（已推送）

| 插件 | 版本 | 安装引用（跨机器可解析） | 仓可见性 |
|---|---|---|---|
| dsh-backup | 0.11.6 | `https://github.com/laituli/dsh-backup.git#v0.11.6` | **public** |
| dsh-stable-network | 0.1.1 | `https://github.com/laituli/dsh-stable-network.git#v0.1.1` | private（需凭据） |
| dsh-personal-workflow | 0.1.0 | `https://github.com/laituli/dsh-personal-workflow.git#v0.1.0` | private（需凭据） |

> 私仓在**新机器**上需要先有凭据：`gh auth login`（本机已登录 laituli）或
> `git config --global credential.helper store` + 写入 PAT。
> 若希望“零凭据冷启动”，把这几个仓设为 public（内容不含凭据）。

## 1. 安装（任选一种，均跨机器可复现）

### 1.1 git URL + tag（**推荐**）

```powershell
dsh plugin --profile web add "https://github.com/laituli/dsh-backup.git#v0.11.6"
dsh plugin --profile web add "https://github.com/laituli/dsh-stable-network.git#v0.1.1"
dsh plugin --profile web add "https://github.com/laituli/dsh-personal-workflow.git#v0.1.0"
```

### 1.2 离线兜底（仅本机已有产物时）

```powershell
$pack = "$env:TEMP\dsh-pack"
dsh plugin --profile web add "$pack\xiaoyuyu6420-dsh-backup-0.11.6.tgz"
dsh plugin --profile web add "$pack\dsh-stable-network-0.1.1.tgz"
dsh plugin --profile web add "$pack\dsh-personal-workflow-0.1.0.tgz"
```

## 2. 冷重启（宿主侧插件只在启动时装配）

```powershell
node "C:\Users\lai\Desktop\dsh-backups\ops.mjs" stop --web-port 3080
& "C:\Program Files\nodejs\node.exe" "C:\Users\lai\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" web
```

（第二行的窗口保持打开——它就是宿主；`--no-open` 可禁用自动开浏览器。）

## 3. 部署后验证

1. Ctrl+F5 → 设置 → **运维**：五个子页（备份 | 重启 | 升级 | 迁移 | 重装/安装），Markdown 渲染、代码块可复制；
2. 备份总览出现「网络超时（秒）」「刚性完成窗口（秒）」；
3. 新会话用 skill 工具能看到 `dsh-personal-workflow`（热注入，非共享目录）；
4. `curl http://127.0.0.1:3080/dsh-stable-network/status` → `online/consecutiveFails/pending/nextProbeAt`；
5. 点一次「④ 建议：立即备份（重启后）」。

## 4. 从 0 装一台新机器（冷启动顺序）

```powershell
# ① 装 dsh 本体（按你的安装方式；npm 全局为例）
npm i -g @deepseek-ai/dsh@latest
# ② 凭据（私仓需要；public 可跳过）
gh auth login
# ③ 装我们配置的插件（与上面 1.1 相同的 URL#tag）
dsh plugin --profile web add "https://github.com/laituli/dsh-backup.git#v0.11.6"
dsh plugin --profile web add "https://github.com/laituli/dsh-stable-network.git#v0.1.1"
dsh plugin --profile web add "https://github.com/laituli/dsh-personal-workflow.git#v0.1.0"
# ④ 启动（首次即冷启动）
dsh web
```

> 「运维 → 重装/安装」页的目标就是把上面 ③（以及 profile 里实际配置的插件清单）**自动生成**成可复制指令——
> 这是下一步要落的 `installPlan`。

## 5. 回滚

- 插件级：`dsh plugin --profile web remove <包名>` + 冷重启；
- 版本级：把 `#vX.Y.Z` 换成旧 tag 重装 + 冷重启；
- 数据级：面板「运维 → 备份」选归档恢复（旧数据挪到 `.dsh.pre-restore-*`，不删除）。

## 6. 已知边界

- 宿主侧重试策略无“时间窗”字段：默认 30 分钟窗口用 `maxRetries=64 / 1000ms / 30000ms` 近似；
- `dsh-stable-network` 目前只有宿主侧能力，前端状态点未接入；
- 两个新仓为 private：跨机器冷启动需要凭据（或改为 public）。
