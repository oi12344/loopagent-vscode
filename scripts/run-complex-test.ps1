# 复杂跨文件关联测试执行脚本

param(
    [string]$ProjectPath = (Get-Location).Path
)

Write-Host "================================================" -ForegroundColor Blue
Write-Host "复杂跨文件关联测试" -ForegroundColor Blue
Write-Host "================================================" -ForegroundColor Blue

# 步骤 1: 关闭现有 VSCode
Write-Host "`n[步骤 1] 关闭现有 VSCode..." -ForegroundColor Cyan
Get-Process | Where-Object {$_.ProcessName -like "*code*"} | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Write-Host "[步骤 1] 完成" -ForegroundColor Green

# 步骤 2: 启动 VSCode
Write-Host "`n[步骤 2] 启动 VSCode (项目: $ProjectPath)..." -ForegroundColor Cyan
.\scripts\start-vscode-debug.ps1
Start-Sleep -Seconds 5
Write-Host "[步骤 2] 完成" -ForegroundColor Green

# 步骤 3: 等待 CDP 就绪
Write-Host "`n[步骤 3] 等待 CDP 就绪..." -ForegroundColor Cyan
$maxAttempts = 30
$attempt = 0
$cdpReady = $false

while ($attempt -lt $maxAttempts -and -not $cdpReady) {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:9333/json/list" -UseBasicParsing -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 200) {
            $cdpReady = $true
            Write-Host "[步骤 3] CDP 已就绪" -ForegroundColor Green
        }
    } catch {
        Start-Sleep -Seconds 2
        $attempt++
    }
}

if (-not $cdpReady) {
    Write-Host "[错误] CDP 启动超时" -ForegroundColor Red
    exit 1
}

# 步骤 4: 运行测试
Write-Host "`n[步骤 4] 运行复杂跨文件关联测试..." -ForegroundColor Cyan
node .\scripts\run-complex-multi-file-test.mjs

$exitCode = $LASTEXITCODE

if ($exitCode -eq 0) {
    Write-Host "`n================================================" -ForegroundColor Green
    Write-Host "测试成功完成！" -ForegroundColor Green
    Write-Host "================================================" -ForegroundColor Green
} else {
    Write-Host "`n================================================" -ForegroundColor Red
    Write-Host "测试失败！" -ForegroundColor Red
    Write-Host "================================================" -ForegroundColor Red
}

exit $exitCode
