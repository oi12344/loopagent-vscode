# Headroom 低 CPU 与速度优先调优实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 在不再运行并行压缩侧车的前提下，为正式 Headroom 代理增加 CPU 和等待上限，并以真实请求验证稳定性与可达到的压缩率。

**架构：** 只修改主启动脚本的安全边界，保持既有 `balanced / 0.30 / 15 items` 策略。通过主代理日志、`/health`、`/stats` 和进程 CPU 增量验证，不向外部模型发送额外基准请求。

**技术栈：** Windows PowerShell 5.1、Headroom `0.31.0`、Responses API、Python `unittest`。

---

### Task 1：定位并消除连接失败来源

- [x] 记录 `8787` 与 `8788` 的进程、线程、CPU 和执行器状态。
- [x] 复现 `8788` 开始压缩后 `8787` 健康请求超时。
- [x] 停止所有命令行包含 `headroom-win-031` 和 `--port 8788` 的进程。
- [x] 确认停止侧车后 `8787` 的 `livez/health/stats` 与真实请求恢复。
- [x] 删除不再安全的 `benchmark_compression_ratios.ps1` 和对应临时自检脚本。

### Task 2：备份并应用主代理安全配置

- [x] 备份 `headroom_start_proxy.ps1` 并记录 SHA256。
- [x] 先运行配置断言，确认旧配置因 `workers=8` 和缺失全局上限而失败。
- [x] 将 `HEADROOM_COMPRESS_WORKERS` 改为 `4`。
- [x] 增加 `HEADROOM_COMPRESSION_MAX_WORKERS=4`。
- [x] 增加 `HEADROOM_COMPRESSION_TIMEOUT_SECONDS=15`。
- [x] 断言 `HEADROOM_TARGET_RATIO=0.30` 和 `HEADROOM_MAX_ITEMS=15` 未改变。
- [x] 运行 PowerShell 语法解析并确认无错误。

### Task 3：重启并验证正式代理

- [x] 停止旧 `8787` 进程并通过正式启动脚本启动新进程。
- [x] 确认 `GET /livez` 返回 `200`。
- [x] 确认 `/health` 报告 `0.31.0 / ratio 0.30 / workers 4 / explicit / timeout 15`。
- [x] 记录 `/readyz=503` 来自上游探活，不把它误判为真实转发失败。
- [x] 确认当前 Codex 会话可继续通过新代理执行请求。

### Task 4：观察真实请求

- [x] 收集至少 10 个重启后的 `gpt-5.6-sol` 请求。
- [x] 统计真实请求失败数、优化延迟 P50/P95 和节省率。
- [x] 采样 3 秒空闲窗口的 Headroom CPU 增量。
- [x] 检查压缩执行器运行数、在途数、队列超时、最长运行时间和泄漏线程。
- [x] 根据速度优先原则决定不继续降低 `target_ratio`。

### Task 5：回归、清理和记录

- [x] 重新运行 5 个 Responses 数组输出补丁测试。
- [x] 确认 `8788` 无监听器且临时比例测试日志已删除。
- [x] 确认主代理连续健康检查和真实请求无失败。
- [x] 写入 `2026-07-10-headroom-40-percent-low-cpu-tuning-verification.md`。
- [x] 运行 `git diff --check` 并提交中文文档。
