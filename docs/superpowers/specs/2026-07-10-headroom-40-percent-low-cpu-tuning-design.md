# Headroom 40% 压缩率与低 CPU 调优设计

## 背景

当前 Codex 请求经 `C:\Users\msi\.codex\headroom_start_proxy.ps1` 启动的 Headroom `0.31.0` 代理转发。代理已经支持 Responses API 的数组形式 `custom_tool_call_output`，主实例位于 `127.0.0.1:8787`。

现有配置使用 `balanced`、`HEADROOM_TARGET_RATIO=0.30`、`HEADROOM_MAX_ITEMS=15` 和 `HEADROOM_COMPRESS_WORKERS=8`。运行状态显示实际累计节省率约为 30%，但全局压缩执行器仍按自动规则扩展到 20 个 worker，因此压缩高峰可能占用过多 CPU。

## 目标

1. 对包含足量、可压缩工具输出的请求，将实际 token 节省率控制在 35% 至 45%，优先接近 40%。
2. 将 Headroom 全局压缩执行器硬限制为最多 4 个 worker。
3. 将 Headroom 对普通 Responses 请求增加的压缩等待限制在 15 秒内；Codex WebSocket 路径沿用内置的 5 秒上限。
4. 候选配置相对 `target_ratio=0.30`、4 worker 基线的压缩处理时间不得增加超过 10%。
5. 在同时满足速度、CPU 硬门槛和 35% 至 45% 节省率区间的配置中，选择处理时间最短的档位；没有档位进入该区间时，选择满足硬门槛的最高实际节省率。
6. 保持主代理稳定，不牺牲 system/user 消息和最近上下文的完整性。
7. 所有运行配置变更都必须可以自动回滚到调优前备份。

## 非目标

- 不承诺所有请求都节省 40%。小请求、无工具输出请求和不可压缩内容允许正常直通，其节省率可以为 0%。
- 不启用 `agent-90`、`HEADROOM_FORCE_KOMPRESS` 或 system/user 消息压缩。
- 不降低 `protect_recent=4`，不提高 `HEADROOM_MAX_ITEMS=15`。
- 不修改 LoopAgent VS Code 扩展源码或模型请求协议。
- 不承诺外部模型服务的网络和生成时间；速度保证只覆盖 Headroom 代理增加的压缩等待。

## 决策优先级

配置选择严格遵循以下顺序：

1. 主代理可用性和请求正确性。
2. Headroom 增加的压缩等待。
3. CPU 和压缩并发上限。
4. 实际 token 节省率。

如果 40% 节省率与速度门槛冲突，必须优先速度，选择满足速度门槛的最高实际节省率，不得通过延长压缩等待换取更高压缩率。

## 调优方案

保持以下行为不变：

- `HEADROOM_SAVINGS_PROFILE=balanced`
- `HEADROOM_MAX_ITEMS=15`
- `HEADROOM_SMART_CRUSHER_COMPACTION=1`
- system/user 消息压缩关闭
- `protect_recent=4`

将以下两个并发限制同时设为 4：

- `HEADROOM_COMPRESS_WORKERS=4`
- `HEADROOM_COMPRESSION_MAX_WORKERS=4`

同时设置 `HEADROOM_COMPRESSION_TIMEOUT_SECONDS=15`。该设置把普通 Responses 请求等待压缩执行器的时间从默认 30 秒缩短到 15 秒。Codex WebSocket 路径在 `headroom.proxy.handlers.openai` 中另有 5 秒硬上限，因此仍以 5 秒为准。压缩超时必须保持 fail-open，让原始请求继续转发；worker 可能在后台完成，所以仍需 4-worker 全局上限防止超时任务堆积。

`HEADROOM_TARGET_RATIO` 表示期望保留比例，值越小越激进。不能直接把“节省 40%”机械地换算为某个配置值，因为实际节省率还受内容类型、保护规则和压缩器可用性影响。应使用相同输入依次测试 `0.30`、`0.25`、`0.20`、`0.15` 和 `0.10`，选择满足实际节省率 35% 至 45% 的最大值；这样可以在达到目标的同时避免不必要的压缩和 CPU 开销。

候选档位首先必须满足：单次离线压缩耗时不超过 15 秒，并且相对 `target_ratio=0.30`、4 worker 基线不增加超过 10%。如果多个档位同时满足速度、CPU 和压缩率目标，按以下顺序选择：

1. 总处理时间更短。
2. CPU 秒数更少。
3. `HEADROOM_TARGET_RATIO` 数值更大。
4. 没有新增泄漏线程。

如果 `0.30` 本身无法满足速度门槛，再测试较温和的 `0.35` 和 `0.40`。此时不再强求 35% 至 45% 节省率，而是选择满足速度门槛的最高实际节省率。

## 基准输入

基准脚本使用 `C:\Users\msi\.codex\headroom-win-031\patch-tests\benchmark_compression_ratios.ps1`。

旧基准把多个历史轮次的工具输出聚合成单个 Responses 请求。这种请求不代表真实调用关系，不能作为有效调优样本。新基准只选取一个已由当前代理接受、长度足够大的真实 `custom_tool_call_output`，并在每个候选比例下重复相同请求。

测试上游固定为未监听的本地端口。请求完成压缩后预期返回 `502`；这可以避免调用外部模型，同时通过 `/stats` 和 `/health` 读取压缩结果、CPU 时间和执行器状态。任何在进入压缩前返回的 `400` 都视为无效样本。

每个候选档位记录：

- 输入字节数和原始 token 数
- 节省 token 数和实际节省率
- 总耗时和 Headroom 进程 CPU 秒数
- 相对 `target_ratio=0.30` 基线的耗时变化百分比
- `compression_executor.max_workers`
- 压缩执行器队列等待和超时次数
- `run_seconds_max`
- `leaked_threads_total`

## 应用与回滚

1. 保留现有调优前备份 `C:\Users\msi\.codex\headroom_start_proxy.ps1.before-40pct-20260710-151952.bak`。
2. 只修改 `headroom_start_proxy.ps1` 中的 worker 限制、15 秒压缩超时和经基准选出的 `HEADROOM_TARGET_RATIO`。
3. 停止 `8787` 的旧 Headroom 进程，并通过启动脚本启动新实例。
4. 轮询 `/health`，确认版本为 `0.31.0`、主代理可用、配置值正确且 `compression_executor.max_workers=4`。
5. 如果监听、健康检查或配置核对失败，立即恢复备份并重新启动；不得留下不可用的 `8787`。

## 验证标准

离线基准必须满足：

- 单个真实大输出进入压缩路径。
- 首选实际 token 节省率为 35% 至 45%；如果该区间与速度或 CPU 硬门槛冲突，则选择满足硬门槛的最高实际节省率，并记录差距。
- 单次压缩耗时不超过 15 秒，且相对 `target_ratio=0.30`、4 worker 基线不增加超过 10%。
- `compression_executor.max_workers=4` 且来源为显式配置。
- 没有请求前置 `400`、压缩队列超时或新增泄漏线程。

主实例必须满足：

- `/health` 返回可用状态，版本为 `0.31.0`。
- `/stats` 中失败请求数不增加。
- 连续观察至少 10 个真实 `gpt-5.6-sol` 请求。
- 对其中包含足量可压缩工具输出的请求，节省率中位数位于 35% 至 45%；小请求和直通请求单独记录，不纳入该中位数。
- `optimization_latency_ms` 的 P95 不超过 15 秒；Codex WebSocket 压缩帧仍不得超过内置的 5 秒等待上限。
- 压缩执行器运行数和在途数不超过 4。
- 没有压缩队列超时，真实请求失败数不增加。
- 与 `target_ratio=0.30`、4 worker 的基准相比，所选档位的 CPU 秒数不得增加超过 25%；如果没有候选同时满足压缩率、速度与 CPU 条件，则优先选择满足速度和 CPU 条件的最高压缩率，并记录未达到 40% 的原因。

## 清理

完成后停止 `8788` 调试代理，删除本次生成的临时比例测试日志，并确认只保留正式补丁测试、基准脚本、启动配置和备份。不得删除用户的会话记录或既有 Headroom 运行日志。
