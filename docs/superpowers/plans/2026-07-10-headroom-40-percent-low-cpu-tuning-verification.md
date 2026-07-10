# Headroom 低 CPU 与速度优先调优验证记录

## 结论

正式 Headroom 代理已保持 `target_ratio=0.30`，并增加 4-worker 全局上限和 15 秒压缩超时。没有继续追求 40% 整请求节省率，因为真实请求中位数只有 7.03%，继续扩大压缩范围需要触及受保护上下文或增加压缩负载，与速度和 CPU 优先级冲突。

## 连接失败根因

连接异常不是本轮主启动脚本文本变更造成的。本轮修改安全参数前，主脚本仍为 `workers=8 / target_ratio=0.30 / max_items=15`，且主 PID 未因用户恢复文件而改变。

实际风险来自遗留的 `8788` 调试代理与正式 `8787` 并行压缩：

- `8788` 指向未监听的 `127.0.0.1:8799`，不是正式流量入口。
- 调试进程曾有约 82 个线程，`run_seconds_max=46.093`，`leaked_threads_total=2`。
- 启动旧比例矩阵后，`8787/health` 在 5 秒内无响应；停止 `8788` 后正式代理恢复。
- `8788` 关闭后，主代理连续健康检查和真实请求均可通过。

因此已删除临时比例矩阵脚本和自检脚本，并禁止在线运行第二个 Headroom 压缩代理。

## 备份

- 路径：`C:\Users\msi\.codex\headroom_start_proxy.ps1.before-stability-20260710-161543.bak`
- SHA256：`794AA87031FB1D3E0E79E09DE05903CDE2DD1D3549CDEBC4D7EA49B3AEDA962D`
- 备份内容：`workers=8 / target_ratio=0.30 / max_items=15`，没有全局 worker 和压缩超时覆盖。

## 最终配置

`C:\Users\msi\.codex\headroom_start_proxy.ps1`：

```powershell
$env:HEADROOM_COMPRESS_WORKERS = "4"
$env:HEADROOM_COMPRESSION_MAX_WORKERS = "4"
$env:HEADROOM_COMPRESSION_TIMEOUT_SECONDS = "15"
$env:HEADROOM_SAVINGS_PROFILE = "balanced"
$env:HEADROOM_TARGET_RATIO = "0.30"
$env:HEADROOM_MAX_ITEMS = "15"
$env:HEADROOM_SMART_CRUSHER_COMPACTION = "1"
```

当前脚本 SHA256：`829ACF5D13B54D7338E2F5A4B054544654891C81B24A6EA982284161D6A86DB5`。

## 重启结果

- 正式监听：`127.0.0.1:8787`
- Headroom PID：`12468`
- 版本：`0.31.0`
- `compression_executor.max_workers=4`
- worker 来源：`explicit`
- 压缩超时：`15.0` 秒
- `target_ratio=0.30`

第一次组合重启命令因等待 `/health.ready=true` 超过工具 60 秒上限而退出，但代理已完成启动并承接真实请求。后续验证确认 `/readyz=503` 来自 Headroom 上游探活状态，不能单独代表转发失败；`livez`、`health`、`stats` 和真实 Responses 请求均正常。

## 真实请求验证

重启后最新快照：

- 请求数：17
- 失败数：0
- 可统计日志记录：17
- 可压缩大请求：16
- `optimization_latency_ms` P95：7.79 ms
- 可压缩大请求整请求节省率中位数：7.03%
- 压缩单元累计节省率：16.10%
- `compression_executor.running=0`
- `compression_executor.in_flight=0`
- `queue_timeouts_total=0`
- 空闲 3 秒 Headroom CPU 增量：0 秒
- 连续 `livez`：5/5 次 HTTP 200
- 连续 `health`：5/5 次 HTTP 200

## 残余风险

- `leaked_threads_total=1`。
- `run_seconds_max=28.437` 秒，说明一次压缩在 15 秒等待超时后仍在底层继续运行。
- 当前全局 4-worker 上限可以阻止无限并发，但不能强制终止已经开始的 Python/Rust 压缩线程。

如果泄漏线程继续增长、空闲 CPU 不再归零、出现队列超时或真实请求失败，应立即恢复上述备份，不再降低 `target_ratio`。

## 回归与清理

- Headroom Responses 数组输出测试：5/5 通过。
- LoopAgent Vitest：23/23 测试文件、67/67 用例通过。
- `npm run typecheck`：退出码 0。
- `npm run compile`：退出码 0。
- `8788`：无监听器。
- `%TEMP%\headroom-ratio-*.out.log` 与 `%TEMP%\headroom-ratio-*.err.log`：剩余 0 个。
- 临时 `benchmark_compression_ratios.ps1` 与 `test_benchmark_compression_ratios.ps1`：已删除。
