# 任务看板（task-board）接口调研

> 状态：**调研中**（由子 agent 负责，结论落地到本文件）。
> 已知：`~/.dsh/task-board/ledger-v2.json`（schemaVersion 3，含 revision/tasks/scheduler/recentRequests）；
> **外部直接改该文件会被插件回写覆盖**（实测：手动改 status 与新增任务约 1 分钟后被回滚）。

待补章节：实现包与文件 → 宿主接口（服务/RPC/HTTP）→ 前端接口（slot/RPC）→ 并发与权威性（revision/lock）→ **agent 可用的受支持写入口（若无请写“无，只能 UI”）** → skill 发现与注册机制 → 复现证据。
