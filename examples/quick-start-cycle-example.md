# 快速开始：简单的审查-修复循环示例

**用时**: 2-3 分钟  
**难度**: ⭐ 入门级

---

## 🎯 最小可行示例

这是一个最简单的审查-修复循环，用于快速验证功能。

```typescript
runDynamicGraph({
  initialNodes: [
    // 步骤 1: 写代码
    {
      id: "write-code",
      task: "编写一个简单的 add(a, b) 函数，返回两数之和",
      role: "executor"
    },

    // 步骤 2: 审查
    {
      id: "review",
      task: `审查代码质量。

检查：
1. 是否有类型定义
2. 是否有参数验证
3. 是否有错误处理

如果所有检查通过，回复：「APPROVED」
否则列出问题。`,
      role: "reviewer",
      dependsOn: ["write-code"]
    },

    // 步骤 3: 修复（仅在审查未通过时执行）
    {
      id: "fix",
      task: "根据审查意见修复代码",
      role: "executor",
      dependsOn: ["review"],
      condition: {
        type: "custom",
        expression: "!review.content.includes('APPROVED')"
      }
    }
  ],

  // 🔄 循环：修复完成后，重新审查
  cycles: [
    {
      id: "simple-loop",
      from: "fix",
      to: "review",
      exit: {
        hardLimit: 3,
        breakWhen: [
          { type: "expression", value: "review.content.includes('APPROVED')" }
        ]
      }
    }
  ]
});
```

---

## 📊 执行流程

### **场景 1: 第一次就通过**
```
write-code → review (APPROVED) → ✅ 完成
```

### **场景 2: 需要 1 轮修复**
```
write-code → review (发现问题) → fix → review (APPROVED) → ✅ 完成
```

### **场景 3: 需要多轮修复**
```
write-code → review (3个问题)
           ↓
         fix (修复2个)
           ↓
         review (还有1个) ← 循环轮1
           ↓
         fix (修复最后1个)
           ↓
         review (APPROVED) ← 循环轮2 → ✅ 完成
```

---

## 🧪 如何测试

### **方法 1: 在对话中测试**

直接对主智能体说：

```
请使用动态工作流执行以下任务：

使用 examples/quick-start-cycle-example.md 中的简单循环示例，
编写、审查和修复一个 add 函数。
```

### **方法 2: 单元测试验证**

运行已创建的集成测试：

```bash
npm test -- dynamicGraphCycleIntegration.test.ts
```

---

## 🎓 核心概念演示

### **1. 条件执行**
```typescript
condition: {
  type: "custom",
  expression: "!review.content.includes('APPROVED')"
}
```
**含义**: 只有审查未通过（不包含 "APPROVED"）时，才执行修复节点。

### **2. 循环边**
```typescript
cycles: [{
  id: "simple-loop",
  from: "fix",    // 修复完成后
  to: "review",   // 重新执行审查
  exit: { ... }
}]
```
**含义**: 形成 `review → fix → review → ...` 的循环。

### **3. 智能退出**
```typescript
exit: {
  hardLimit: 3,  // 最多 3 轮
  breakWhen: [
    { type: "expression", value: "审查通过条件" }
  ]
}
```
**含义**: 审查通过时立即停止，或达到 3 轮后强制停止。

---

## 📈 扩展练习

### **练习 1: 添加无进展检测**

```typescript
cycles: [{
  id: "simple-loop",
  from: "fix",
  to: "review",
  exit: {
    hardLimit: 5,
    breakWhen: [
      { type: "expression", value: "review.content.includes('APPROVED')" }
    ],
    // 👇 新增
    adaptive: {
      detectNoProgress: true,
      progressWindow: 2,
      similarityThreshold: 0.9
    }
  }
}]
```

**效果**: 如果连续 2 轮审查结果相似度 > 90%，自动停止。

---

### **练习 2: 添加成本控制**

```typescript
exit: {
  hardLimit: 5,
  breakWhen: [
    { type: "expression", value: "review.content.includes('APPROVED')" }
  ],
  adaptive: {
    detectNoProgress: false,
    progressWindow: 2,
    costBudget: 20000  // 👈 20k tokens 预算
  }
}
```

**效果**: 累计 token 超过 20k 时自动停止。

---

### **练习 3: 添加测试节点**

```typescript
initialNodes: [
  { id: "write-code", task: "写代码", role: "executor" },
  { id: "review", task: "审查", role: "reviewer", dependsOn: ["write-code"] },
  { id: "fix", task: "修复", role: "executor", dependsOn: ["review"], condition: {...} },
  
  // 👇 新增测试节点
  {
    id: "test",
    task: "运行单元测试验证功能",
    role: "executor",
    dependsOn: ["review"],
    toolHints: ["runCommand"]
  }
]
```

---

## 🎯 学习路径

1. ✅ **理解基础循环** - 运行这个简单示例
2. 📚 **学习条件节点** - 理解 `condition` 的作用
3. 🔄 **掌握智能退出** - 添加 `adaptive` 配置
4. 🚀 **实战应用** - 查看 `code-review-workflow-example.md`
5. 💡 **创新应用** - 设计自己的工作流

---

## 💬 常见问题

### **Q: 为什么 fix 节点有 condition？**
A: 如果审查第一次就通过，就不需要修复，直接跳过 fix 节点。

### **Q: 循环会不会无限执行？**
A: 不会。有三重保护：
1. `hardLimit` - 硬上限
2. `breakWhen` - 退出条件
3. `adaptive.detectNoProgress` - 无进展检测

### **Q: 如何查看循环执行了几轮？**
A: 在返回结果的 `cycleStatistics` 中查看 `totalIterations`。

### **Q: 如何调试循环问题？**
A: 添加 `include: ["debug"]` 查看详细的执行信息。

---

## 📝 总结

这个简单示例只有 **3 个节点 + 1 个循环边**，但展示了：

- ✅ 基础循环机制
- ✅ 条件执行
- ✅ 智能退出
- ✅ 节点重用（不创建新节点）

**下一步**: 查看 [code-review-workflow-example.md](code-review-workflow-example.md) 了解生产级应用！
