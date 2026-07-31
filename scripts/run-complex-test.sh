#!/bin/bash

echo "============================================================"
echo "复杂跨文件关联测试 - 自动化执行"
echo "============================================================"

# 步骤 1: 关闭现有 VSCode
echo ""
echo "[步骤 1] 关闭现有 VSCode..."
powershell.exe -Command "Get-Process | Where-Object {\$_.ProcessName -like '*code*'} | Stop-Process -Force -ErrorAction SilentlyContinue" 2>/dev/null
sleep 3
echo "[步骤 1] 完成"

# 步骤 2: 启动 VSCode 调试模式（后台）
echo ""
echo "[步骤 2] 启动独立的 VSCode 实例（调试模式）..."
# 使用 nohup 和 & 确保完全后台运行
nohup powershell.exe -File ./scripts/start-vscode-debug.ps1 > /dev/null 2>&1 &
sleep 15
echo "[步骤 2] 完成"

# 步骤 3: 等待 CDP 就绪
echo ""
echo "[步骤 3] 等待 CDP 就绪..."
attempts=0
max_attempts=40

while [ $attempts -lt $max_attempts ]; do
    if curl -s http://127.0.0.1:9333/json/list > /dev/null 2>&1; then
        echo "[步骤 3] CDP 已就绪"
        break
    fi
    sleep 2
    attempts=$((attempts + 1))
    if [ $((attempts % 5)) -eq 0 ]; then
        echo "[步骤 3] 等待中... ($attempts/$max_attempts)"
    fi
done

if [ $attempts -eq $max_attempts ]; then
    echo "[错误] CDP 启动超时"
    exit 1
fi

# 步骤 4: 等待扩展加载
echo ""
echo "[步骤 4] 等待扩展加载..."
sleep 5
echo "[步骤 4] 完成"

# 步骤 5: 运行测试
echo ""
echo "[步骤 5] 运行复杂跨文件关联测试..."
echo "============================================================"
node ./scripts/run-complex-multi-file-test.mjs

exit_code=$?

echo ""
echo "============================================================"
if [ $exit_code -eq 0 ]; then
    echo "✅ 测试成功完成！"
    echo ""
    echo "查看结果："
    echo "  - 截图: .artifacts/complex-multi-file-test.png"
    echo "  - 报告: .artifacts/complex-multi-file-test.md"
else
    echo "❌ 测试失败！退出码: $exit_code"
fi
echo "============================================================"

exit $exit_code
