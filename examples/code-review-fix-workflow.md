# 代码审查与自动修复工作流示例

本文档展示如何使用动态工作流实现：审查代码 → 发现问题 → 自动修复 → 再审查的循环。

---

## 场景 1：单文件审查 + 条件修复

**用途：** 实现一个功能后，审查代码质量，如果有问题则修复。

```typescript
runDynamicGraph({
  initialNodes: [
    {
      id: "implement-auth",
      task: "在 src/auth.ts 中实现 JWT 认证功能",
      role: "executor"
    },
    
    {
      id: "review-auth",
      task: `审查 src/auth.ts 的代码质量，检查：
1. SQL 注入风险
2. XSS 漏洞
3. 密码存储安全性
4. Token 过期处理

如果发现问题，详细列出每个问题的位置和修复建议。
如果没有问题，明确回复「无安全问题」。`,
      role: "reviewer",
      dependsOn: ["implement-auth"],
      exportTo: "authReview"
    },
    
    {
      id: "fix-auth",
      task: "根据审查意见修复 src/auth.ts 的安全问题",
      role: "executor",
      dependsOn: ["review-auth"],
      inputMapping: {
        reviewFindings: "globalData.authReview"
      },
      condition: {
        type: "custom",
        // 只有审查发现问题时才执行修复
        expression: "!nodes['review-auth'].content.includes('无安全问题')"
      }
    }
  ]
});
```

**执行结果：**
- 如果审查通过：`implement-auth` → `review-auth` → ✅ 结束
- 如果发现问题：`implement-auth` → `review-auth` → `fix-auth` → ✅ 结束

---

## 场景 2：自动迭代修复（推荐）⭐

**用途：** 自动重复"修复 → 审查"循环，直到通过或达到最大轮数。

```typescript
runDynamicGraph({
  initialNodes: [
    {
      id: "implement-payment",
      task: "实现支付模块 src/payment.ts",
      role: "executor"
    },
    
    {
      id: "reflect-review-1",
      task: `审查 src/payment.ts 的代码安全性。

如果所有检查都通过，回复：「APPROVED: 代码审查通过」
如果发现问题，详细列出每个问题及修复建议。`,
      role: "reviewer",
      dependsOn: ["implement-payment"]
    }
  ],
  
  resolvers: [
    {
      nodeId: "reflect-review-1",
      resolverType: "iterative",
      resolverConfig: {
        maxRounds: 3,  // 最多 3 轮修复
        
        reviseTask: `根据上一轮审查意见修复 src/payment.ts 的问题。

## 审查反馈
{previousReview}

请逐一修复所有列出的问题。`,
        
        reviewTask: `重新审查修复后的 src/payment.ts。

## 上一轮修订内容
{revision}

检查问题是否已全部修复。如果通过，回复「APPROVED」。`,
        
        reviseRole: "executor",
        reviewRole: "reviewer",
        approvalText: "APPROVED"  // 审查通过的关键词
      }
    }
  ]
});
```

**执行流程：**

```
implement-payment
      ↓
reflect-review-1 (第1轮审查)
      ↓ (发现问题)
reflect-revise-2 (第1轮修复)
      ↓
reflect-review-2 (第2轮审查)
      ↓ (还有问题)
reflect-revise-3 (第2轮修复)
      ↓
reflect-review-3 (第3轮审查)
      ↓ (通过或达到上限)
✅ 结束
```

**工作原理：**
1. 审查节点检查代码，返回结果
2. Resolver 判断结果是否包含 `"APPROVED"`
3. 如果未通过且未达到 `maxRounds`，创建修复节点
4. 修复节点完成后，自动创建下一轮审查节点
5. 循环直到通过或达到最大轮数

---

## 场景 3：多文件并行审查 + 统一修复

**用途：** 审查多个文件，收集所有问题后统一修复。

```typescript
runDynamicGraph({
  initialNodes: [
    {
      id: "scan-files",
      task: "列出 src/ 目录下所有 .ts 文件，返回 JSON 数组",
      role: "explorer",
      exportTo: "allFiles"
    },
    
    // 聚合节点需要等待所有审查完成
    {
      id: "aggregate-issues",
      task: `聚合所有文件的审查结果，生成问题清单。

对每个文件的审查结果进行汇总，按严重程度排序。`,
      role: "planner",
      dependsOn: ["scan-files"],  // 初始依赖，fanout 节点会自动添加
      inputMapping: {
        // 这里会在 fanout 后动态更新依赖
        allReviews: "globalData.reviewResults"
      }
    },
    
    {
      id: "batch-fix",
      task: "根据聚合的问题清单，批量修复所有高优先级问题",
      role: "executor",
      dependsOn: ["aggregate-issues"],
      inputMapping: {
        issueList: "nodes['aggregate-issues'].content"
      },
      condition: {
        type: "custom",
        expression: "nodes['aggregate-issues'].content.length > 100"
      }
    }
  ],
  
  resolvers: [
    {
      nodeId: "scan-files",
      resolverType: "fanout",
      resolverConfig: {
        itemsExpression: "JSON.parse(nodes['scan-files'].content)",
        idPrefix: "review-file-",
        task: "审查文件的代码质量，返回问题列表（JSON 格式）",
        role: "reviewer",
        itemInputKey: "filePath"
      }
    }
  ]
});
```

**执行流程：**

```
scan-files (发现 5 个文件)
    ↓
  fanout resolver 创建 5 个并行审查节点
    ↓
[review-file-0] [review-file-1] [review-file-2] [review-file-3] [review-file-4]
    ↓ ↓ ↓ ↓ ↓ (全部完成)
aggregate-issues (汇总所有问题)
    ↓
batch-fix (批量修复)
```

---

## 场景 4：审查 → 修复 → 测试 → 循环

**用途：** 完整的质量保证流程。

```typescript
runDynamicGraph({
  initialNodes: [
    {
      id: "implement-feature",
      task: "实现新功能并编写单元测试",
      role: "executor"
    },
    
    {
      id: "review-code",
      task: "审查代码质量",
      role: "reviewer",
      dependsOn: ["implement-feature"]
    },
    
    {
      id: "fix-issues",
      task: "修复审查发现的问题",
      role: "executor",
      dependsOn: ["review-code"],
      condition: {
        type: "onFailure"  // 只有审查失败时才执行
      }
    },
    
    {
      id: "run-tests",
      task: "运行单元测试，确保修复没有破坏功能",
      role: "executor",
      dependsOn: ["fix-issues"],
      toolHints: ["runCommand"]
    },
    
    {
      id: "verify-fix",
      task: "验证问题是否已修复且测试通过",
      role: "reviewer",
      dependsOn: ["run-tests"]
    }
  ]
});
```

---

## 最佳实践

### 1. **明确审查通过标准**

在审查任务中明确说明通过条件：

```typescript
task: `审查代码安全性。

检查项：
1. SQL 注入防护
2. XSS 防护
3. CSRF Token

如果所有检查通过，回复：「APPROVED: 所有安全检查通过」
否则列出具体问题。`
```

### 2. **使用 `exportTo` 传递审查结果**

```typescript
{
  id: "review",
  exportTo: "reviewResult",  // 导出到全局数据
  // ...
}
```

后续节点可以通过 `inputMapping` 读取：

```typescript
{
  id: "fix",
  inputMapping: {
    issues: "globalData.reviewResult"
  }
}
```

### 3. **设置合理的 `maxRounds`**

对于 iterative resolver：
- 简单修复：`maxRounds: 2`
- 复杂问题：`maxRounds: 3-5`
- 避免设置过高（会消耗大量 token）

### 4. **使用条件节点避免不必要的修复**

```typescript
condition: {
  type: "custom",
  expression: "!nodes['review'].content.includes('APPROVED')"
}
```

---

## 工具权限说明

| 角色 | 可用工具 | 适用场景 |
|------|---------|---------|
| `reviewer` | `exploreCode`, `readFile` | 只读审查，不修改代码 |
| `executor` | `exploreCode`, `readFile`, `applyEdit`, `runCommand` | 修复问题，运行测试 |
| `planner` | `exploreCode`, `readFile` | 生成修复计划 |

---

## 调试技巧

### 查看工作流执行计划

```typescript
runDynamicGraph({
  // ... 你的配置
  include: ["visualization", "debug"]  // 👈 添加这个
});
```

返回结果会包含：
- `visualization`：ASCII 可视化图
- `debugInfo`：详细的节点执行信息
- `executionOrder`：节点执行顺序

### 监控实时状态

在 VS Code 中查看 **OUTPUT** 面板 → **LoopAgent** 频道，可以看到：
- 节点创建事件
- 状态变更
- Resolver 触发

---

## 总结

| 模式 | 适用场景 | 复杂度 | 修复轮数 |
|------|---------|--------|---------|
| 简单串行 | 单次审查修复 | ⭐ | 1 |
| 迭代修复 | 需要多轮改进 | ⭐⭐ | 1-5 |
| 并行审查 | 多文件批量处理 | ⭐⭐⭐ | 1 |
| 完整 QA | 审查+测试循环 | ⭐⭐⭐⭐ | 可配置 |

**推荐：** 对于大多数场景，使用 **场景 2（自动迭代修复）** 即可满足需求。
