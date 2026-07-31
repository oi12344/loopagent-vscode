# Java 物流接口 E2E 测试启动脚本
#
# 功能：
# 1. 启动 VSCode 并启用 CDP 调试端口
# 2. 打开 yguc-biz 项目
# 3. 定位到 LogisticsController.java
# 4. 在对话中提问新增物流信息接口
# 5. 捕获模型的推理过程和结果
# 6. 生成测试报告和截图

$ErrorActionPreference = "Stop"

$VSCODE_PATH = "C:\Users\msi\AppData\Local\Programs\Microsoft VS Code\Code.exe"
$CDP_PORT = 9333
$EXTENSION_PATH = $PSScriptRoot | Split-Path -Parent
$TEST_SCRIPT = Join-Path $PSScriptRoot "run-java-logistics-e2e.mjs"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Java 物流接口 E2E 测试" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# 检查 VSCode 是否存在
if (-not (Test-Path $VSCODE_PATH)) {
    Write-Host "❌ 未找到 VSCode: $VSCODE_PATH" -ForegroundColor Red
    exit 1
}

Write-Host "✓ 找到 VSCode: $VSCODE_PATH" -ForegroundColor Green

# 检查测试脚本是否存在
if (-not (Test-Path $TEST_SCRIPT)) {
    Write-Host "❌ 未找到测试脚本: $TEST_SCRIPT" -ForegroundColor Red
    exit 1
}

Write-Host "✓ 找到测试脚本: $TEST_SCRIPT" -ForegroundColor Green

# 启动 VSCode 实例（带 CDP 调试端口）
Write-Host "`n[步骤 1/2] 启动 VSCode（CDP 端口: $CDP_PORT）..." -ForegroundColor Yellow

$vscodeArgs = @(
    "--remote-debugging-port=$CDP_PORT",
    "--disable-extensions",
    "--extensionDevelopmentPath=$EXTENSION_PATH",
    "--new-window",
    "--user-data-dir=$env:TEMP\vscode-java-logistics-e2e"
)

Write-Host "启动命令: $VSCODE_PATH $($vscodeArgs -join ' ')" -ForegroundColor Gray

$vscodeProcess = Start-Process -FilePath $VSCODE_PATH -ArgumentList $vscodeArgs -PassThru -WindowStyle Normal

Write-Host "✓ VSCode 进程已启动 (PID: $($vscodeProcess.Id))" -ForegroundColor Green
Write-Host "  等待 10 秒让扩展加载..." -ForegroundColor Gray

Start-Sleep -Seconds 10

# 运行测试脚本
Write-Host "`n[步骤 2/2] 运行测试脚本..." -ForegroundColor Yellow

try {
    node $TEST_SCRIPT
    $exitCode = $LASTEXITCODE

    if ($exitCode -eq 0) {
        Write-Host "`n✅ 测试成功完成！" -ForegroundColor Green
        Write-Host "`n查看测试结果：" -ForegroundColor Cyan
        Write-Host "  - 截图: .artifacts\java-logistics-e2e.png" -ForegroundColor White
        Write-Host "  - 报告: .artifacts\java-logistics-e2e.md" -ForegroundColor White
    } else {
        Write-Host "`n❌ 测试失败（退出码: $exitCode）" -ForegroundColor Red
    }

} catch {
    Write-Host "`n❌ 测试执行异常: $_" -ForegroundColor Red
    $exitCode = 1
}

# 清理提示
Write-Host "`n" -NoNewline
$cleanup = Read-Host "是否关闭 VSCode 测试实例？(Y/n)"

if ($cleanup -ne 'n' -and $cleanup -ne 'N') {
    Write-Host "关闭 VSCode 进程..." -ForegroundColor Gray
    Stop-Process -Id $vscodeProcess.Id -Force -ErrorAction SilentlyContinue
    Write-Host "✓ VSCode 已关闭" -ForegroundColor Green
} else {
    Write-Host "保持 VSCode 运行，你可以手动查看结果" -ForegroundColor Yellow
    Write-Host "VSCode PID: $($vscodeProcess.Id)" -ForegroundColor Gray
}

exit $exitCode
