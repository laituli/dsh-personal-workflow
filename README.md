# dsh-personal-workflow

把「自定义 dsh / dsh 插件开发的工作流」以 **skill** 形态热注入给 agent 的个人插件。

- **装载即注入**：插件启动时把 `skills/<name>/` 复制到 `<DSH_HOME>/skills/<name>/`；
- **卸载即移除**：插件卸载时删除注入的目录（拔出 = agent 不再知道这套工作流）；
- 为什么不写成文档：agent 的入口是会话技能目录，仓库里的 md 它看不到。

## 安装

```bash
dsh plugin --profile web add https://github.com/laituli/dsh-personal-workflow.git
# 或本地 tarball：npm pack && dsh plugin --profile web add <绝对路径>.tgz
```

装完 **冷重启宿主**（宿主侧插件只在启动时装配）。

## 验证

1. 重启后确认 `<DSH_HOME>/skills/dsh-personal-workflow/SKILL.md` 存在；
2. 新开会话，用 skill 工具确认该 skill 可见；
3. 卸载插件（`dsh plugin --profile web remove dsh-personal-workflow`）并重启 → 目录应消失。

## 待办

- [ ] 确认 DSH 是否提供 skill 的**可编程注册接口**；有则改为服务注册（比复制文件更干净）。
- [ ] 把任务看板接口结论纳入本仓 `docs/taskboard-interface.md`（调研中）。
