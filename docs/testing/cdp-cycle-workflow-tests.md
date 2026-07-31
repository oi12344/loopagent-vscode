# CDP 端到端测试指南

本指南介绍如何运行循环工作流的 CDP 端到端测试。

---

## 📋 测试脚本列表

| 脚本 | 难度 | 测试内容 | 预计时间 |
|------|------|---------|---------|
| `test-cycle-workflow-cdp.mjs` | ⭐ 简单 | 基础审查-修复循环 | 2-3 分钟 |
| `test-complex-cycle-workflow-cdp.mjs` | ⭐⭐⭐ 复杂 | 多循环协同工作流 | 5-10 分钟 |

---

## 🚀 运行前准备

### 1. 启动 VSCode 调试模式

在项目根目录运行：

```powershell
# PowerShell
.\scripts\start-vscode-debug.ps1
```

或

```bash
# Bash (Git Bash)
./scripts/start-vscode-debug.sh
```

**检查点：**
- ✅ VSCode 应该在新窗口中启动
- ✅ 控制台应该显示 `CDP 已启用在端口 9333`
- ✅ 扩展应该正常加载

### 2. 确保 LoopAgent 扩展已激活

在 VSCode 中：
1. 按 `Ctrl+Shift+P`
2. 输入 "LoopAgent"
3. 确认扩展已激活

---

## 🧪 测试 1：基础循环测试

### 运行命令

```bash
node scripts/test-cycle-workflow-cdp.mjs
```

### 测试内容

- **工作流**: 编写代码 → 审查 → 修复 → 审查（循环）
- **验证点**:
  - ✅ 使用 `runDynamicGraph`
  - ✅ 循环被触发
  - ✅ 智能退出生效
  - ✅ 节点正确重置和重新执行

### 预期输出

```
======================================================================
循环工作流 CDP E2E 测试
======================================================================

[连接] 正在连接到 CDP 端口 9333...
[步骤1] 准备对话会话
[步骤1] 会话已准备
[步骤2] 提交循环工作流测试...
[步骤2] 任务已提交，等待响应...

[检测] ✅ 检测到循环关键词！
[检测] 🔄 循环轮数: 1
[进度] 内容: 1234字 | 工具: 3次 | 动态图: ✅ | 循环: ✅ | 轮数: 1 | 耗时: 45s
[检测] 🔄 循环轮数: 2
[进度] 内容: 2567字 | 工具: 5次 | 动态图: ✅ | 循环: ✅ | 轮数: 2 | 耗时: 89s

[完成] 总耗时 105s

[验证结果]
  动态工作流: ✅ 已使用
  循环机制: ✅ 已触发
  循环轮数: 2 轮
  审查通过: ✅ 是

[步骤3] 截图已保存: .artifacts/cycle-workflow-test.png
[步骤4] 报告已保存: .artifacts/cycle-workflow-test.md

======================================================================
测试完成
======================================================================

{
  "success": true,
  "usedDynamicGraph": true,
  "detectedCycle": true,
  "cycleIterations": 2,
  "hasApproved": true,
  "elapsed": 105,
  "screenshotPath": ".artifacts/cycle-workflow-test.png",
  "transcriptPath": ".artifacts/cycle-workflow-test.md"
}
```

### 成功标准

- ✅ 退出码: 0
- ✅ `success: true`
- ✅ `usedDynamicGraph: true`
- ✅ `detectedCycle: true`
- ✅ `cycleIterations >= 1`

---

## 🧪 测试 2：复杂多循环测试

### 运行命令

```bash
node scripts/test-complex-cycle-workflow-cdp.mjs
```

### 测试内容

- **工作流**: 实现 → 安全审查循环 → 质量审查循环 → 报告
- **验证点**:
  - ✅ 两个独立循环都被触发
  - ✅ 循环之间正确协调（串行执行）
  - ✅ 每个循环独立退出
  - ✅ 最终报告包含统计信息

### 预期输出

```
================================================================================
复杂多循环工作流 CDP E2E 测试
================================================================================

[连接] 正在连接到 CDP 端口 9333...
[步骤1] 准备对话会话
[步骤2] 提交复杂多循环工作流...

[检测] ✅ 检测到安全循环（security-loop）
[检测] 🔄 安全循环轮数: 1
[进度] 安全循环: ✅(1轮) | 质量循环: ❌ | 节点: 3 | 耗时: 67s

[检测] 🔄 安全循环轮数: 2
[进度] 安全循环: ✅(2轮) | 质量循环: ❌ | 节点: 4 | 耗时: 134s

[检测] ✅ 检测到质量循环（quality-loop）
[检测] 🔄 质量循环轮数: 1
[进度] 安全循环: ✅(2轮) | 质量循环: ✅(1轮) | 节点: 5 | 耗时: 189s

[完成] 总耗时 210s

[验证结果]
  动态工作流: ✅ 已使用
  安全循环: ✅ 已触发 (2轮)
  质量循环: ✅ 已触发 (1轮)
  安全审查: ✅ 通过
  质量审查: ✅ 通过
  节点执行: 6 个

======================================================================
测试完成
======================================================================

{
  "success": true,
  "usedDynamicGraph": true,
  "securityLoop": {
    "detected": true,
    "iterations": 2
  },
  "qualityLoop": {
    "detected": true,
    "iterations": 1
  },
  "securityApproved": true,
  "qualityApproved": true,
  "totalNodes": 6,
  "elapsed": 210
}
```

### 成功标准

- ✅ 退出码: 0
- ✅ `success: true`
- ✅ `usedDynamicGraph: true`
- ✅ `securityLoop.detected: true`
- ✅ `qualityLoop.detected: true`
- ✅ 至少一个循环有 `iterations >= 1`

---

## 📊 测试结果查看

### 1. 截图

测试完成后会自动保存截图：
- 基础测试: `.artifacts/cycle-workflow-test.png`
- 复杂测试: `.artifacts/complex-cycle-workflow-test.png`

### 2. 详细报告

测试报告保存为 Markdown 格式：
- 基础测试: `.artifacts/cycle-workflow-test.md`
- 复杂测试: `.artifacts/complex-cycle-workflow-test.md`

报告包含：
- 测试目标和预期行为
- 详细的验证结果表格
- 循环统计信息
- 助手的完整响应
- 结论和建议

### 3. JSON 结果

测试脚本会输出 JSON 格式的结果到 stdout，可以用于 CI/CD：

```bash
# 保存结果到文件
node scripts/test-cycle-workflow-cdp.mjs > test-result.json

# 提取特定字段
node scripts/test-cycle-workflow-cdp.mjs | jq '.cycleIterations'
```

---

## 🔧 故障排查

### 问题 1: "Connection refused"

**原因**: VSCode 调试模式未启动或 CDP 端口不是 9333

**解决**:
```bash
# 1. 确认 VSCode 正在运行
ps aux | grep "code.*9333"

# 2. 重新启动调试模式
./scripts/start-vscode-debug.ps1
```

---

### 问题 2: "webview window missing"

**原因**: LoopAgent 视图未打开

**解决**:
1. 在 VSCode 中手动打开 LoopAgent 视图
2. 等待 2-3 秒确保加载完成
3. 重新运行测试

---

### 问题 3: "未检测到循环"

**原因**: 
- 模型选择了其他实现方式
- 提示词不够明确

**解决**:
1. 检查 `.artifacts/` 中的报告，查看助手实际响应
2. 如果助手使用了 Reflection Resolver 而不是 cycles，这是预期的（都是有效的循环实现）
3. 修改提示词更明确地要求使用 `cycles` 参数

---

### 问题 4: 超时

**原因**: 复杂工作流执行时间超过预设

**解决**:
```javascript
// 修改超时时间（在脚本顶部）
const TURN_TIMEOUT_MS = 600_000; // 改为 10 分钟
```

---

## 🎯 CI/CD 集成

### GitHub Actions 示例

```yaml
name: E2E Cycle Workflow Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Start VSCode Debug
        run: ./scripts/start-vscode-debug.ps1
        shell: powershell
      
      - name: Wait for VSCode
        run: sleep 10
      
      - name: Run Basic Cycle Test
        run: node scripts/test-cycle-workflow-cdp.mjs
      
      - name: Run Complex Cycle Test
        run: node scripts/test-complex-cycle-workflow-cdp.mjs
      
      - name: Upload artifacts
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: test-artifacts
          path: .artifacts/
```

---

## 📝 测试检查清单

运行测试前：
- [ ] VSCode 调试模式已启动（端口 9333）
- [ ] LoopAgent 扩展已激活
- [ ] 没有其他对话正在进行

运行测试后检查：
- [ ] 退出码为 0
- [ ] JSON 结果中 `success: true`
- [ ] 截图正常生成
- [ ] 报告包含完整信息
- [ ] 循环被正确检测

---

## 🎓 扩展测试

### 自定义测试场景

复制并修改现有脚本：

```javascript
// 自定义提示
const CUSTOM_PROMPT = `
您的自定义工作流定义...
`;

// 自定义验证逻辑
const hasCustomFeature = fullContent.includes("您的特征");
```

### 性能基准测试

```bash
# 运行 10 次取平均值
for i in {1..10}; do
  node scripts/test-cycle-workflow-cdp.mjs | jq '.elapsed'
done | awk '{s+=$1} END {print "Average:", s/NR, "seconds"}'
```

---

## 📚 相关文档

- [双向图设计方案](../docs/superpowers/plans/2026-07-30-bidirectional-graph-design.md)
- [动态循环退出策略](../docs/superpowers/plans/2026-07-30-dynamic-cycle-exit-strategies.md)
- [快速开始示例](./examples/quick-start-cycle-example.md)
- [完整代码审查工作流](./examples/code-review-workflow-example.md)

---

## ✅ 总结

这些 CDP 测试脚本提供了：
- ✅ 端到端验证循环功能
- ✅ 真实 VSCode 环境测试
- ✅ 详细的测试报告
- ✅ 可集成到 CI/CD
- ✅ 完整的故障排查指南

**现在可以开始测试了！** 🚀
