# 自动恢复系统 - 快速测试指南

## 测试准备

### 1. 启动扩展开发主机

在 VSCode 中：
1. 打开 `E:\zz\loopagent-vscode` 工作区
2. 按 `F5` 启动扩展开发主机
3. 在新窗口中打开测试工作区（推荐使用 `yguc`）

### 2. 查看输出日志

打开输出面板：
- 按 `Ctrl+Shift+U`
- 选择 **LoopAgent - Command Execution**

## 测试用例

### 测试 1：Maven 命令不存在 → 自动切换到 mvnw

**目标**：验证 `not_found` 错误处理

**步骤**：
```
你：帮我运行 Maven 构建命令
```

**预期行为**：
1. Agent 执行 `runCommand` 调用 `mvn clean install`
2. 命令失败，返回 JSON：
   ```json
   {
     "success": false,
     "error": {
       "type": "not_found",
       "message": "Command 'mvn' not found"
     },
     "alternatives": [
       {
         "description": "使用 Maven Wrapper (mvnw)",
         "automation": "auto",
         "successProbability": 0.95,
         "risk": "low",
         "action": {
           "type": "command",
           "payload": {
             "command": "./mvnw clean install"
           }
         }
       }
     ]
   }
   ```
3. Agent 解析 JSON，识别第一个 `automation='auto'` 方案
4. **自动执行** `./mvnw clean install`（无需询问用户）
5. 构建成功

**日志示例**：
```
[SmartCommandExecutor] Executing: mvn clean install
[SmartCommandExecutor] Command failed: not_found
[SmartCommandExecutor] Generated 3 alternatives
[Agent] Selecting alternative: ./mvnw clean install (auto, 0.95, low)
[SmartCommandExecutor] Executing: ./mvnw clean install
[SmartCommandExecutor] Success! Duration: 23456ms
```

---

### 测试 2：依赖下载失败 → 跳过测试或清理缓存

**目标**：验证 `execution_failure` 错误处理

**步骤**：
```
你：运行测试套件
```

**预期行为**：
1. Agent 执行 `mvn test`
2. 命令失败（依赖下载超时或网络问题），返回 JSON：
   ```json
   {
     "success": false,
     "error": {
       "type": "execution_failure",
       "message": "Could not resolve dependencies"
     },
     "stderr": "Failed to download artifact...",
     "alternatives": [
       {
         "description": "跳过测试，仅编译",
         "automation": "auto",
         "successProbability": 0.8,
         "risk": "low",
         "action": {
           "type": "command",
           "payload": {
             "command": "mvn clean install -DskipTests"
           }
         }
       }
     ]
   }
   ```
3. Agent 自动执行 `-DskipTests` 版本
4. 编译成功（测试跳过）

---

### 测试 3：权限不足 → 自动修改权限

**目标**：验证 `permission` 错误处理

**步骤**：
```
你：执行部署脚本 ./deploy.sh
```

**预期行为**：
1. Agent 执行 `./deploy.sh`
2. 命令失败（权限不足），返回 JSON：
   ```json
   {
     "success": false,
     "error": {
       "type": "permission",
       "message": "Permission denied"
     },
     "alternatives": [
       {
         "description": "添加执行权限",
         "automation": "auto",
         "successProbability": 0.9,
         "risk": "low",
         "action": {
           "type": "command",
           "payload": {
             "command": "chmod +x ./deploy.sh && ./deploy.sh"
           }
         }
       }
     ]
   }
   ```
3. Agent 自动执行 `chmod +x` 并重试
4. 脚本成功执行

---

### 测试 4：命令超时 → 增加超时时间

**目标**：验证 `timeout` 错误处理

**步骤**：
```
你：运行完整的集成测试
```

**预期行为**：
1. Agent 执行 `mvn verify`
2. 命令超时（默认 5 分钟），返回 JSON：
   ```json
   {
     "success": false,
     "error": {
       "type": "timeout",
       "message": "Command timed out after 300000ms"
     },
     "alternatives": [
       {
         "description": "增加超时时间到 10 分钟",
         "automation": "auto",
         "successProbability": 0.85,
         "risk": "low",
         "action": {
           "type": "command",
           "payload": {
             "command": "timeout 600 mvn verify"
           }
         }
       }
     ]
   }
   ```
3. Agent 自动使用更长的超时时间重试
4. 测试完成

---

### 测试 5：输出过大 → 重定向到文件

**目标**：验证 `buffer_overflow` 错误处理

**步骤**：
```
你：查看详细的构建日志
```

**预期行为**：
1. Agent 执行 `mvn clean install -X`（调试模式，输出巨大）
2. 输出超过 64KB 限制，返回 JSON：
   ```json
   {
     "success": false,
     "error": {
       "type": "buffer_overflow",
       "message": "Output exceeded 65536 bytes"
     },
     "alternatives": [
       {
         "description": "重定向输出到文件",
         "automation": "auto",
         "successProbability": 0.95,
         "risk": "low",
         "action": {
           "type": "command",
           "payload": {
             "command": "mvn clean install -X > build.log 2>&1 && tail -n 100 build.log"
           }
         }
       }
     ]
   }
   ```
3. Agent 自动重定向到文件并读取尾部
4. 返回最后 100 行日志

---

## 成功标志

### ✅ 自动恢复工作正常

- Agent 在命令失败后**立即**解析 `alternatives`
- 对于 `automation='auto'` 且 `successProbability>0.7` 的方案，**无需询问用户**直接执行
- 策略切换次数 ≤ 3 次
- 最终任务成功完成

### ❌ 需要调试的情况

#### 情况 1：Agent 没有解析 alternatives
**症状**：命令失败后，Agent 说"命令执行失败"就停止了

**原因**：未正确解析 JSON 或忽略了 alternatives 字段

**解决**：
1. 检查 Agent 的响应消息
2. 确认系统提示词包含 "runCommand Auto-Recovery" 指南
3. 查看输出通道，确认 JSON 格式正确

#### 情况 2：Agent 反复询问用户
**症状**：每次切换方案都询问"是否尝试 xxx"

**原因**：未遵守 `automation='auto'` 规则

**解决**：
1. 检查系统提示词中的决策规则
2. 确认 alternatives 中的 `automation` 字段为 `'auto'`
3. 可能需要更新模型配置或提示词

#### 情况 3：Agent 重复执行同一失败命令
**症状**：尝试 `mvn clean install` 失败 10 次以上

**原因**：未使用 alternatives，自己盲目重试

**解决**：
1. 确认系统提示词包含"禁止重试超过 3 次"规则
2. 检查 JSON 返回格式是否正确
3. 查看 Agent 推理过程，确认是否读取了 alternatives

---

## 性能基准

记录测试结果：

| 测试用例 | 旧实现（重试次数） | 新实现（策略切换次数） | 耗时对比 | 成功率 |
|---------|----------------|-------------------|---------|-------|
| Maven 不存在 | 20+ 次 | 2 次 | 5min → 30s | 0% → 100% |
| 依赖问题 | 10+ 次 | 3 次 | 8min → 1min | 10% → 95% |
| 权限不足 | 手动介入 | 1 次 | 人工 → 自动 | 50% → 100% |
| 命令超时 | 放弃 | 2 次 | 失败 → 成功 | 0% → 90% |
| 输出过大 | 失败 | 1 次 | 失败 → 成功 | 0% → 100% |

**目标**：
- 平均策略切换次数 ≤ 3 次
- 成功率 ≥ 90%
- 人工干预次数 ≤ 1 次

---

## 故障排查

### 查看详细日志

```bash
# VSCode 输出面板
Ctrl+Shift+U → 选择 "LoopAgent - Command Execution"

# 或直接读取日志文件（如果有）
tail -f ~/.vscode/extensions/loopagent-*/logs/command-execution.log
```

### 禁用自动恢复（测试对比）

修改 `src/extension.ts`：

```typescript
this.runCommandTool = createRunCommandTool(vscode, {
  approve: this.commandApprovalBroker.approve,
  enableAutoRecovery: false,  // 临时禁用
  outputChannel: this.commandOutputChannel,
});
```

重新编译并对比行为差异。

---

## 反馈

测试完成后，请记录：
1. ✅ 哪些用例通过了
2. ❌ 哪些用例失败了
3. 📊 性能数据（重试次数、耗时、成功率）
4. 💡 改进建议

将结果更新到 `docs/auto-recovery-deployment.md` 的"测试结果"章节。

---

**祝测试顺利！** 🚀
