# Headroom 低 CPU 与速度优先调优设计

## 背景

Codex 通过 `C:\Users\msi\.codex\headroom_start_proxy.ps1` 启动的 Headroom `0.31.0` 代理访问 Responses API，正式端口为 `127.0.0.1:8787`。用户希望可压缩请求尽量接近 40% token 节省率，同时不能明显增加 CPU 占用或响应等待。

早期方案在 `8788` 启动第二个 Headroom 代理复放历史工具输出。真实执行证明该方案会与正式代理争用 CPU 和压缩线程：`8788` 曾出现 `run_seconds_max=46.093`、`leaked_threads_total=2` 和约 82 个线程；正式 `8787` 的健康请求在侧车开始压缩后可直接超时。停止 `8788` 后，正式代理的 `livez`、`health`、`stats` 和真实请求恢复。

因此禁止在 Codex 正通过 `8787` 工作时运行并行 Headroom 压缩基准。

## 目标与优先级

按以下顺序做取舍：

1. 正式代理可连接，真实请求不失败。
2. Headroom 新增等待受控。
3. CPU 并发和泄漏线程影响受控。
4. 在前三项满足后提高 token 节省率。

40% 是期望目标，不是硬性保证。小请求、受保护的最近上下文、system/user 消息和不可压缩内容允许直通。

## 最终配置

保留既有稳定策略：

- `HEADROOM_SAVINGS_PROFILE=balanced`
- `HEADROOM_TARGET_RATIO=0.30`
- `HEADROOM_MAX_ITEMS=15`
- `HEADROOM_SMART_CRUSHER_COMPACTION=1`
- 不压缩 system/user 消息
- 不降低 `protect_recent=4`

增加安全边界：

- `HEADROOM_COMPRESS_WORKERS=4`
- `HEADROOM_COMPRESSION_MAX_WORKERS=4`
- `HEADROOM_COMPRESSION_TIMEOUT_SECONDS=15`

Codex WebSocket 路径仍受 Headroom 内置 5 秒压缩等待上限约束。普通 Responses 路径最多等待 15 秒；超时后 fail-open，原请求继续转发。底层线程无法被 Python 强制终止，因此全局 4-worker 上限用于阻止超时任务无限堆积。

## 调优方式

不再使用在线侧车矩阵。只观察正式代理重启后的真实 `gpt-5.6-sol` 请求：

- 先固定 `target_ratio=0.30`，至少观察 10 个顺序请求。
- 记录失败数、`optimization_latency_ms` P95、CPU 空闲增量、`run_seconds_max`、泄漏线程和队列超时。
- 只有在失败数为 0、P95 远低于 15 秒、无持续 CPU 占用且无新增泄漏趋势时，才允许单步降低比例。
- 每次只改变一个参数，重新启动后重新观察至少 10 个请求。
- 若整请求节省率仍明显低于 40%，但进一步扩大压缩范围会触及受保护上下文或增加 CPU，则停止调优并如实记录上限。

## 健康判定

`/readyz` 会受 Headroom 上游探活影响，在真实转发正常时仍可能返回 `503`，不能单独作为启动失败依据。正式代理验收使用：

- `GET /livez` 返回 `200`。
- `GET /health` 和 `GET /stats` 可在 5 秒内返回。
- 运行配置报告版本 `0.31.0`、`max_workers=4`、来源 `explicit`、超时 `15`。
- 至少 10 个真实请求，失败增量为 0。
- 压缩执行器无队列超时，空闲窗口 CPU 增量为 0。

## 回滚

调优前备份为：

`C:\Users\msi\.codex\headroom_start_proxy.ps1.before-stability-20260710-161543.bak`

SHA256：

`794AA87031FB1D3E0E79E09DE05903CDE2DD1D3549CDEBC4D7EA49B3AEDA962D`

如果真实请求失败、`8787` 不再监听、CPU 持续占用或泄漏线程持续增长，恢复该备份并重启正式代理。不得恢复或重启 `8788`。

## 非目标

- 不修改 LoopAgent VS Code 扩展源码。
- 不启用 `agent-90` 或强制 Kompress。
- 不调用额外外部模型进行基准测试。
- 不以牺牲连接稳定性或响应速度换取 40% 数字。
