# 部署清单（三个包 + 一次冷重启）

> 适用：把 `dsh-backup 0.11.6`、`dsh-stable-network 0.1.0`、`dsh-personal-workflow 0.1.0` 装进
> `web` profile 并生效。**宿主侧插件只在启动时装配 → 必须冷重启一次**（客户端产物只需 F5）。

## 0. 前置：产物就绪（已由开发侧完成）

| 包 | 产物 | 位置 |
|---|---|---|
| dsh-backup | `xiaoyuyu6420-dsh-backup-0.11.6.tgz`（197 KB） | `%TEMP%\dsh-pack\`（如需长期保存请复制到备份目录或仓库附件） |
| dsh-stable-network | `dsh-stable-network-0.1.0.tgz`（8.7 KB） | 同上 |
| dsh-personal-workflow | `dsh-personal-workflow-0.1.0.tgz`（7.5 KB） | 同上 |

## 1. 安装（PowerShell，一次粘贴）

```powershell
$pack = "$env:TEMP\dsh-pack"
dsh plugin --profile web add "$pack\xiaoyuyu6420-dsh-backup-0.11.6.tgz"
dsh plugin --profile web add "$pack\dsh-stable-network-0.1.0.tgz"
dsh plugin --profile web add "$pack\dsh-personal-workflow-0.1.0.tgz"
```

> 也可以走 git URL（等价、且灾时更可取）：
> `dsh plugin --profile web add https://github.com/laituli/dsh-stable-network.git` 等。

## 2. 冷重启（成对指令；先停旧、再启新）

```powershell
node "C:\Users\lai\Desktop\dsh-backups\ops.mjs" stop --web-port 3080
& "C:\Program Files\nodejs\node.exe" "C:\Users\lai\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" web
```

（第二行的窗口保持打开——它就是宿主；想不自动弹浏览器加 `--no-open`。）

## 3. 部署后验证

1. 浏览器 **Ctrl+F5**；设置 → **运维** 应有五个子页（备份 | 重启 | 升级 | 迁移 | 重装/安装），文档为 Markdown、代码块可复制；
2. 备份总览里应出现「**网络超时（秒）**」与「**刚性完成窗口（秒）**」两个输入；
3. 新开会话，用 skill 工具确认 `dsh-personal-workflow` 可见（**热注入生效**）；
4. `curl http://127.0.0.1:3080/dsh-stable-network/status` 应返回 `online/consecutiveFails/pending/nextProbeAt`；
5. 点一次「④ 建议：立即备份（重启后）」——让备份目录里的 `rescue.mjs`/`ops.mjs` 刷新到当前版本。

## 4. 回滚

- 插件级：`dsh plugin --profile web remove <包名>` + 冷重启；
- 数据级：面板「运维 → 备份」里选一份归档恢复（旧数据会挪到 `.dsh.pre-restore-*`，不删除）。

## 5. 已知边界

- `dsh-backup` 的「刚性完成」只在**网络类动作**（fetch/push/pull）上生效；窗口内重试到成功，
  窗口用尽仍失败才报错（`githubRetryWindowSec=0` 可关闭重试）；
- `dsh-stable-network` 目前是**宿主侧**（探测/熔断/队列/镜像源信息），前端状态点尚未接入（下一切片）；
- `dsh-personal-workflow` 的 skill 注入走 `ctx.skills.registerProvider`，注册随 fiber 生命周期——
  卸载插件即移除（不是写进共享的 `<DSH_HOME>/skills`）。
