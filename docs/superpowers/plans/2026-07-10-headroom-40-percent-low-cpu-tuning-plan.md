# Headroom 40% 压缩率与低 CPU 调优实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 在保证 Headroom 新增压缩延迟和 CPU 并发受控的前提下，使可压缩大请求的实际 token 节省率优先落入 35% 至 45%。

**架构：** 使用独立的 `8788` 本地代理和未监听的 `8799` 上游复放单个真实数组工具输出，按相同输入测量候选比例；选定档位后只修改 `8787` 启动脚本，并用已有备份执行失败自动回滚。LoopAgent 源码和外部模型接口均不修改。

**技术栈：** Windows PowerShell 5.1、Headroom `0.31.0`、Responses API、Headroom `/health` 与 `/stats`、现有 Python 回归测试。

---

## 文件边界

- 修改 `C:\Users\msi\.codex\headroom-win-031\patch-tests\benchmark_compression_ratios.ps1`：构造单输出基准、校验 HTTP 状态并记录压缩率、CPU、延迟与执行器指标。
- 新增 `C:\Users\msi\.codex\headroom-win-031\patch-tests\test_benchmark_compression_ratios.ps1`：快速验证基准载荷只包含一个真实数组输出，不启动代理。
- 修改 `C:\Users\msi\.codex\headroom_start_proxy.ps1`：写入最终比例、4-worker 硬上限和 15 秒压缩超时。
- 保留 `C:\Users\msi\.codex\headroom_start_proxy.ps1.before-40pct-20260710-151952.bak`：启动失败时恢复。
- 新增 `docs/superpowers/plans/2026-07-10-headroom-40-percent-low-cpu-tuning-verification.md`：记录候选矩阵、选型、重启与真实请求验收证据。

### Task 1：让基准只复放一个有效数组工具输出

**Files:**
- Create: `C:\Users\msi\.codex\headroom-win-031\patch-tests\test_benchmark_compression_ratios.ps1`
- Modify: `C:\Users\msi\.codex\headroom-win-031\patch-tests\benchmark_compression_ratios.ps1`
- Test: `C:\Users\msi\.codex\headroom-win-031\patch-tests\test_benchmark_compression_ratios.ps1`

- [ ] **Step 1：先写载荷自检脚本**

```powershell
$ErrorActionPreference = "Stop"

$benchmark = Join-Path $PSScriptRoot "benchmark_compression_ratios.ps1"
$result = & $benchmark -ValidatePayloadOnly | ConvertFrom-Json

if ($result.InputItems -ne 1) {
    throw "Expected exactly one input item, got $($result.InputItems)"
}
if ($result.ItemType -ne "custom_tool_call_output") {
    throw "Expected custom_tool_call_output, got $($result.ItemType)"
}
if ($result.OutputKind -ne "array") {
    throw "Expected an array-form output, got $($result.OutputKind)"
}
if ([string]::IsNullOrWhiteSpace([string]$result.CallId)) {
    throw "Expected a non-empty call_id"
}
if ([int64]$result.PayloadBytes -lt 10000) {
    throw "Expected a payload of at least 10000 bytes, got $($result.PayloadBytes)"
}

Write-Output "PASS: benchmark payload contains one valid array output"
```

- [ ] **Step 2：运行自检并确认先失败**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\msi\.codex\headroom-win-031\patch-tests\test_benchmark_compression_ratios.ps1"
```

Expected: FAIL，错误指出 `benchmark_compression_ratios.ps1` 不支持 `-ValidatePayloadOnly`，证明旧脚本尚未满足单输出契约。

- [ ] **Step 3：为基准增加参数和单输出选择**

在脚本顶部增加：

```powershell
[CmdletBinding()]
param(
    [double[]]$Ratios = @(0.30, 0.25, 0.20, 0.15, 0.10),
    [switch]$ValidatePayloadOnly
)
```

删除固定 `$ratios`，把旧的 `$inputItems` 聚合块替换为：

```powershell
$candidates = @(Get-Content -LiteralPath $sessionFile.FullName | ForEach-Object {
    try {
        $record = $_ | ConvertFrom-Json
        if (
            $record.type -eq "response_item" -and
            $record.payload.type -eq "custom_tool_call_output" -and
            -not [string]::IsNullOrWhiteSpace([string]$record.payload.call_id) -and
            $record.payload.output -is [array]
        ) {
            $outputJson = $record.payload.output | ConvertTo-Json -Depth 20 -Compress
            if ($outputJson.Length -ge 10000) {
                [pscustomobject]@{
                    Type = [string]$record.payload.type
                    CallId = [string]$record.payload.call_id
                    Output = $record.payload.output
                    OutputChars = $outputJson.Length
                }
            }
        }
    } catch {
        # Ignore unrelated or partially written JSONL records.
    }
})

$selected = $candidates | Sort-Object OutputChars -Descending | Select-Object -First 1
if ($null -eq $selected) {
    throw "No array-form custom_tool_call_output of at least 10000 characters was found"
}

$inputItems = @([ordered]@{
    type = $selected.Type
    call_id = $selected.CallId
    output = $selected.Output
})
$payload = [ordered]@{
    model = "gpt-5.6-sol"
    stream = $false
    input = $inputItems
}
$body = $payload | ConvertTo-Json -Depth 20 -Compress

if ($ValidatePayloadOnly) {
    [pscustomobject]@{
        InputItems = $inputItems.Count
        ItemType = $selected.Type
        OutputKind = "array"
        CallId = $selected.CallId
        OutputChars = $selected.OutputChars
        PayloadBytes = [Text.Encoding]::UTF8.GetByteCount($body)
    } | ConvertTo-Json -Depth 4
    return
}
```

将端口占用检查放在 `-ValidatePayloadOnly` 提前返回之后，并把正式循环改为 `foreach ($ratio in $Ratios)`。

- [ ] **Step 4：让正式基准拒绝无效 400，并记录速度指标**

在环境变量区加入：

```powershell
$env:HEADROOM_COMPRESSION_TIMEOUT_SECONDS = "15"
```

把忽略全部异常的请求块替换为：

```powershell
$httpStatus = 200
try {
    Invoke-WebRequest -UseBasicParsing `
        -Uri "http://127.0.0.1:$port/v1/responses" `
        -Method Post `
        -Headers @{ Authorization = "Bearer local-test" } `
        -ContentType "application/json" `
        -Body $body `
        -TimeoutSec 45 | Out-Null
} catch {
    if ($null -eq $_.Exception.Response) {
        throw
    }
    $httpStatus = [int]$_.Exception.Response.StatusCode
    if ($httpStatus -ne 502) {
        throw "Benchmark request failed before the expected upstream error: HTTP $httpStatus"
    }
}
```

给结果对象增加：

```powershell
HttpStatus = $httpStatus
ExecutorSource = [string]$health.runtime.compression_executor.source
QueueTimeouts = [int]$health.runtime.compression_executor.queue_timeouts_total
```

在输出前以 `0.30` 行为基线增加相对指标：

```powershell
$baseline = $results | Where-Object { [double]$_.TargetRatio -eq 0.30 } | Select-Object -First 1
if ($null -eq $baseline) {
    throw "Ratios must include the 0.30 baseline"
}
foreach ($row in $results) {
    $elapsedChange = 100.0 * ($row.ElapsedMs - $baseline.ElapsedMs) / $baseline.ElapsedMs
    $cpuChange = if ($baseline.CpuSeconds -gt 0) {
        100.0 * ($row.CpuSeconds - $baseline.CpuSeconds) / $baseline.CpuSeconds
    } else {
        0.0
    }
    $row | Add-Member NoteProperty ElapsedVsBaselinePercent ([math]::Round($elapsedChange, 2))
    $row | Add-Member NoteProperty CpuVsBaselinePercent ([math]::Round($cpuChange, 2))
}
```

- [ ] **Step 5：运行自检并确认通过**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\msi\.codex\headroom-win-031\patch-tests\test_benchmark_compression_ratios.ps1"
```

Expected: `PASS: benchmark payload contains one valid array output`。

- [ ] **Step 6：运行现有 Responses 补丁回归测试**

Run:

```powershell
& "C:\Users\msi\.codex\headroom-win-031\Scripts\python.exe" -m pytest -q "C:\Users\msi\.codex\headroom-win-031\patch-tests\test_responses_output_slots.py"
```

Expected: `5 passed`。

### Task 2：运行受限矩阵并选出最快合格档位

**Files:**
- Run: `C:\Users\msi\.codex\headroom-win-031\patch-tests\benchmark_compression_ratios.ps1`
- Record: `docs/superpowers/plans/2026-07-10-headroom-40-percent-low-cpu-tuning-verification.md`

- [ ] **Step 1：只停止遗留的 8788 调试代理**

Run:

```powershell
$targets = Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and
    $_.CommandLine -like "*headroom-win-031*" -and
    $_.CommandLine -match "(--port\s+8788|--port[= ]8788)"
}
$targets | Sort-Object ProcessId -Descending | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
```

Expected: `Get-NetTCPConnection -LocalPort 8788 -State Listen` 不再返回监听器；`8787` 仍保持监听。

- [ ] **Step 2：运行主候选矩阵**

Run:

```powershell
& "C:\Users\msi\.codex\headroom-win-031\patch-tests\benchmark_compression_ratios.ps1" `
    -Ratios 0.30,0.25,0.20,0.15,0.10
```

Expected: 每行 `InputItems=1`、`HttpStatus=502`、`ExecutorWorkers=4`、`ExecutorSource=explicit`、`QueueTimeouts=0`；不得出现 `400`。

- [ ] **Step 3：按硬门槛选择 `SelectedRatio`**

候选必须同时满足：

```text
ElapsedMs <= 15000
ElapsedVsBaselinePercent <= 10
CpuVsBaselinePercent <= 25
ExecutorWorkers == 4
QueueTimeouts == 0
LeakedThreads == 0
```

先过滤出 `UnitSavingsPercent` 位于 35 至 45 的候选，按 `ElapsedMs`、`CpuSeconds` 升序和 `TargetRatio` 降序排序，第一行的 `TargetRatio` 定义为 `SelectedRatio`。如果没有进入 35 至 45 的候选，则从满足硬门槛的候选中选择 `UnitSavingsPercent` 最高的一行。

如果 `0.30` 自身超过 15 秒，再运行：

```powershell
& "C:\Users\msi\.codex\headroom-win-031\patch-tests\benchmark_compression_ratios.ps1" `
    -Ratios 0.30,0.35,0.40
```

Expected: 得到一个满足速度与 CPU 硬门槛的 `SelectedRatio`；如果全部失败，停止配置变更并记录阻塞证据。

### Task 3：写入配置并执行失败自动回滚重启

**Files:**
- Modify: `C:\Users\msi\.codex\headroom_start_proxy.ps1`
- Backup: `C:\Users\msi\.codex\headroom_start_proxy.ps1.before-40pct-20260710-151952.bak`

- [ ] **Step 1：运行配置断言并确认旧配置先失败**

Run:

```powershell
$text = Get-Content -Raw -LiteralPath "C:\Users\msi\.codex\headroom_start_proxy.ps1"
if ($text -notmatch 'HEADROOM_COMPRESS_WORKERS\s*=\s*"4"') { throw "worker limit is not 4" }
if ($text -notmatch 'HEADROOM_COMPRESSION_MAX_WORKERS\s*=\s*"4"') { throw "global worker limit is missing" }
if ($text -notmatch 'HEADROOM_COMPRESSION_TIMEOUT_SECONDS\s*=\s*"15"') { throw "15 second timeout is missing" }
```

Expected: FAIL，至少报告旧的 worker 值或缺失的全局 worker/超时配置。

- [ ] **Step 2：核对备份并修改启动脚本**

先运行：

```powershell
Get-FileHash -Algorithm SHA256 "C:\Users\msi\.codex\headroom_start_proxy.ps1.before-40pct-20260710-151952.bak"
```

Expected: 文件存在且返回 SHA256。随后使用 `apply_patch` 完成三个局部编辑：

```powershell
$env:HEADROOM_COMPRESS_WORKERS = "4"
$env:HEADROOM_COMPRESSION_MAX_WORKERS = "4"
$env:HEADROOM_COMPRESSION_TIMEOUT_SECONDS = "15"
```

并把 `$env:HEADROOM_TARGET_RATIO` 写成 Task 2 得到的 `SelectedRatio` 字面值。其他配置保持不变。

- [ ] **Step 3：运行配置断言并确认通过**

重复 Task 3 Step 1 的命令，并额外断言启动脚本中的 `HEADROOM_TARGET_RATIO` 等于 `SelectedRatio`。

Expected: 命令退出码为 0。

- [ ] **Step 4：重启 8787，并在失败时恢复备份**

停止命令行同时包含 `headroom-win-031` 和 `--port 8787` 的进程，确认端口释放，然后运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\msi\.codex\headroom_start_proxy.ps1"
```

最多轮询 30 秒读取 `http://127.0.0.1:8787/health`。成功条件：

```text
ready == true
version == 0.31.0
config.target_ratio == SelectedRatio
runtime.compression_executor.max_workers == 4
runtime.compression_executor.source == explicit
runtime.anthropic_pre_upstream.compression_timeout_seconds == 15
```

任一条件失败时，停止新进程，执行：

```powershell
Copy-Item -LiteralPath "C:\Users\msi\.codex\headroom_start_proxy.ps1.before-40pct-20260710-151952.bak" `
    -Destination "C:\Users\msi\.codex\headroom_start_proxy.ps1" `
    -Force
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\msi\.codex\headroom_start_proxy.ps1"
```

恢复后必须重新确认 `8787` 可用，再停止实施并报告失败。

### Task 4：验证真实请求速度、稳定性和压缩率

**Files:**
- Read: `C:\Users\msi\.codex\headroom-runtime\headroom_proxy_custom.jsonl`
- Read: `http://127.0.0.1:8787/health`
- Read: `http://127.0.0.1:8787/stats`

- [ ] **Step 1：记录重启后的计数基线**

记录 `/stats` 的请求数、失败数、单位 token、队列超时、泄漏线程和进程 CPU 秒数，并记录当前时间为 `ValidationStartedAt`。

- [ ] **Step 2：通过当前 Codex 会话完成至少 10 个真实 `gpt-5.6-sol` 请求**

后续测试、健康检查、日志统计和文档更新必须分成至少 10 个顺序工具回合，使每次返回结果都经真实 Codex Responses 路径进入下一请求。不得额外调用外部模型 API，也不得为凑数开启并行 VS Code 或 Codex 实例。

- [ ] **Step 3：统计重启后的真实请求**

从 JSONL 中筛选 `timestamp >= ValidationStartedAt` 且 `model == "gpt-5.6-sol"` 的记录。计算：

```text
请求总数
失败请求增量
savings_percent
optimization_latency_ms P50/P95
input_tokens_original >= 10000 且 tokens_saved > 0 的可压缩大请求节省率中位数
```

Expected:

```text
请求总数 >= 10
失败请求增量 == 0
optimization_latency_ms P95 <= 15000
compression_executor.running <= 4
compression_executor.in_flight <= 4
queue_timeouts_total == 0
```

可压缩大请求节省率中位数优先为 35% 至 45%；若低于目标，必须确认速度和 CPU 门槛仍满足并如实记录。

- [ ] **Step 4：检查 CPU 与线程泄漏**

计算验证窗口内 Headroom 进程 CPU 秒数增量，并核对 `/health` 的 `run_seconds_max`、`leaked_threads_total`。不得出现执行器饱和、队列超时或持续增长的泄漏线程；若发生，恢复调优前备份。

### Task 5：清理、记录并完成验证

**Files:**
- Create: `docs/superpowers/plans/2026-07-10-headroom-40-percent-low-cpu-tuning-verification.md`
- Modify: `docs/superpowers/plans/2026-07-10-headroom-40-percent-low-cpu-tuning-plan.md`

- [ ] **Step 1：清理调试资源**

停止任何仍监听 `8788` 且命令行包含 `headroom-win-031` 的进程。删除 `%TEMP%\headroom-ratio-*.out.log`、`%TEMP%\headroom-ratio-*.err.log`、`%TEMP%\headroom-ratio-debug.out.log` 和 `%TEMP%\headroom-ratio-debug.err.log`。不得触碰 `8787` 正式日志或 Codex 会话文件。

- [ ] **Step 2：运行最终回归验证**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\msi\.codex\headroom-win-031\patch-tests\test_benchmark_compression_ratios.ps1"
& "C:\Users\msi\.codex\headroom-win-031\Scripts\python.exe" -m pytest -q "C:\Users\msi\.codex\headroom-win-031\patch-tests\test_responses_output_slots.py"
```

Expected: PowerShell 自检 PASS，Python 测试 `5 passed`。

- [ ] **Step 3：写中文验证记录并更新任务勾选**

验证记录必须包含：备份路径和哈希、完整候选矩阵、`SelectedRatio`、最终环境变量、重启后 PID、10 个真实请求统计、延迟 P50/P95、CPU 秒数、执行器上限、失败数、泄漏线程和清理结果。把本计划中实际完成的复选框更新为 `[x]`；未满足项保持 `[ ]` 并在验证记录中说明原因。

- [ ] **Step 4：检查并提交项目文档**

Run:

```powershell
git diff --check
git status --short
```

Expected: 只包含本计划、设计规格修正和验证记录。提交命令：

```powershell
git add docs/superpowers/specs/2026-07-10-headroom-40-percent-low-cpu-tuning-design.md `
    docs/superpowers/plans/2026-07-10-headroom-40-percent-low-cpu-tuning-plan.md `
    docs/superpowers/plans/2026-07-10-headroom-40-percent-low-cpu-tuning-verification.md
git commit -m "docs: record headroom tuning verification"
```
