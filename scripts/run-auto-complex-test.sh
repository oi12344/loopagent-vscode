#!/bin/bash

echo "============================================================"
echo "复杂跨文件关联测试 - 完全自动化版本"
echo "============================================================"

# 步骤 1: 关闭现有测试实例
echo ""
echo "[步骤 1] 清理环境..."
powershell.exe -Command "Get-Process | Where-Object {\$_.ProcessName -like '*code*' -and \$_.MainWindowTitle -like '*Extension Development Host*'} | Stop-Process -Force -ErrorAction SilentlyContinue" 2>/dev/null
sleep 3
echo "[步骤 1] 完成"

# 步骤 2: 启动 VSCode（当前项目）
echo ""
echo "[步骤 2] 启动 VSCode 测试环境..."
powershell.exe -File ./scripts/start-vscode-debug.ps1 &
sleep 15
echo "[步骤 2] 完成"

# 步骤 3: 等待 CDP 就绪
echo ""
echo "[步骤 3] 等待 CDP 就绪（端口 9333）..."
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
sleep 10
echo "[步骤 4] 完成"

# 步骤 5: 运行测试（使用修复后的脚本）
echo ""
echo "[步骤 5] 运行复杂跨文件关联测试..."
echo "============================================================"

# 设置超时为 10 分钟
timeout 600 node ./scripts/run-complex-multi-file-test.mjs

exit_code=$?

echo ""
echo "============================================================"
if [ $exit_code -eq 0 ]; then
    echo "✅ 测试成功完成！"
    echo ""
    echo "查看结果："
    echo "  - 截图: .artifacts/complex-multi-file-test.png"
    echo "  - 报告: .artifacts/complex-multi-file-test.md"
    echo ""

    # 显示关键指标
    if [ -f .artifacts/complex-multi-file-test.md ]; then
        echo "报告摘要："
        grep -E "动态工作流|推理|工具调用" .artifacts/complex-multi-file-test.md | head -10
    fi
elif [ $exit_code -eq 124 ]; then
    echo "⚠️  测试超时（10分钟）"
else
    echo "❌ 测试失败！退出码: $exit_code"
fi
echo "============================================================"

exit $exit_code
