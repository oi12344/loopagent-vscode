#!/bin/bash

echo "============================================================"
echo "复杂跨文件关联测试 - 独立窗口模式"
echo "============================================================"

# 检查是否有其他测试实例在运行
if curl -s http://127.0.0.1:9444/json/list > /dev/null 2>&1; then
    echo ""
    echo "[警告] 检测到端口 9444 已被占用，关闭旧的测试实例..."
    # 找到使用 9444 端口的进程并关闭
    powershell.exe -Command "Get-Process | Where-Object {(\$_.MainWindowTitle -like '*Extension Development Host*') -and (\$_.CommandLine -like '*9444*')} | Stop-Process -Force -ErrorAction SilentlyContinue" 2>/dev/null
    sleep 3
fi

# 步骤 1: 启动独立的 VSCode 测试实例（使用不同的端口）
echo ""
echo "[步骤 1] 启动独立的 VSCode 测试实例（端口 9444）..."
echo "[步骤 1] 当前会话的 VSCode 不会被影响"

# 创建临时启动脚本
cat > /tmp/start-test-vscode.ps1 << 'EOF'
# 启动独立的 VSCode Extension Development Host
$extensionPath = (Get-Location).Path
$codePath = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"

if (-not (Test-Path $codePath)) {
    $codePath = "C:\Program Files\Microsoft VS Code\Code.exe"
}

if (-not (Test-Path $codePath)) {
    Write-Error "找不到 VS Code"
    exit 1
}

Write-Host "启动 VSCode Extension Development Host (端口 9444)..."

# 启动参数
$args = @(
    "--extensionDevelopmentPath=$extensionPath",
    "--inspect-extensions=9444",
    "--disable-extensions",
    "--new-window"
)

Start-Process -FilePath $codePath -ArgumentList $args -WindowStyle Normal
Write-Host "VSCode 测试实例已启动"
EOF

# 执行启动脚本（后台运行）
powershell.exe -File /tmp/start-test-vscode.ps1 &
sleep 20

# 步骤 2: 等待 CDP 就绪
echo ""
echo "[步骤 2] 等待测试实例 CDP 就绪（端口 9444）..."
attempts=0
max_attempts=40

while [ $attempts -lt $max_attempts ]; do
    if curl -s http://127.0.0.1:9444/json/list > /dev/null 2>&1; then
        echo "[步骤 2] CDP 已就绪"
        break
    fi
    sleep 2
    attempts=$((attempts + 1))
    if [ $((attempts % 5)) -eq 0 ]; then
        echo "[步骤 2] 等待中... ($attempts/$max_attempts)"
    fi
done

if [ $attempts -eq $max_attempts ]; then
    echo "[错误] CDP 启动超时"
    echo "[提示] 请检查 VSCode 是否成功启动"
    exit 1
fi

# 步骤 3: 等待扩展加载
echo ""
echo "[步骤 3] 等待扩展加载完成..."
sleep 10
echo "[步骤 3] 完成"

# 步骤 4: 修改测试脚本使用端口 9444
echo ""
echo "[步骤 4] 创建测试配置..."
cat > /tmp/test-config.json << 'EOF'
{
  "cdpPort": 9444,
  "timeout": 600000
}
EOF

# 步骤 5: 运行测试
echo ""
echo "[步骤 5] 运行复杂跨文件关联测试..."
echo "============================================================"

# 临时修改测试脚本的端口
sed 's/const CDP_PORT = 9333;/const CDP_PORT = 9444;/' ./scripts/run-complex-multi-file-test.mjs > /tmp/run-test-temp.mjs

node /tmp/run-test-temp.mjs

exit_code=$?

# 清理
rm -f /tmp/start-test-vscode.ps1 /tmp/test-config.json /tmp/run-test-temp.mjs

echo ""
echo "============================================================"
if [ $exit_code -eq 0 ]; then
    echo "✅ 测试成功完成！"
    echo ""
    echo "查看结果："
    echo "  - 截图: .artifacts/complex-multi-file-test.png"
    echo "  - 报告: .artifacts/complex-multi-file-test.md"
    echo ""
    echo "测试实例仍在运行，可以手动查看结果"
    echo "关闭测试实例命令: pkill -f '9444'"
else
    echo "❌ 测试失败！退出码: $exit_code"
fi
echo "============================================================"

exit $exit_code
