# Hermes vs LoopAgent：自我进化架构对比

## 执行摘要

**核心差异**：Hermes 实现了**跨会话的能力持久化**（技能自我生成与改进），而 LoopAgent 目前是**单会话的工作流编排**（子代理协作但无能力积累）。

---

## 一、架构对比矩阵

| 维度 | Hermes Agent | LoopAgent VSCode |
|------|-------------|------------------|
| **记忆系统** | ✅ 跨会话经验池 + 用户建模 | ⚠️ 项目记忆（fact/decision/lesson）但未集成到子代理 |
| **技能进化** | ✅ 自主创建、持久化、使用中改进 | ❌ 无技能系统 |
| **工作流编排** | ✅ 隔离子代理 + 并行执行 | ✅ DAG 子代理 + 并发控制 |
| **反思机制** | ✅ 任务完成后自动触发技能生成 | ❌ 无自动反思 |
| **跨会话连续性** | ✅ FTS5 会话搜索 + 上下文压缩 | ⚠️ 记忆系统存在但隔离 |
| **工具动态生成** | ✅ Python 脚本作为新工具 | ❌ 静态工具集 |
| **失败学习** | ✅ 技能在实际使用中自我改进 | ❌ 失败不产生持久化知识 |

---

## 二、Hermes 的自我进化机制

### 2.1 三层学习循环

```
┌─────────────────────────────────────────┐
│  Level 3: 元学习（Meta-Learning）        │
│  - 技能生成器自己也在进化                │
│  - 学习"如何学习"新能力                  │
└────────────┬────────────────────────────┘
             │
┌────────────▼────────────────────────────┐
│  Level 2: 技能进化（Skill Evolution）    │
│  - 任务完成 → 自动提取可复用技能          │
│  - 技能在使用中持续改进                  │
│  - 成功率低的技能被优化或废弃            │
└────────────┬────────────────────────────┘
             │
┌────────────▼────────────────────────────┐
│  Level 1: 记忆积累（Memory）             │
│  - 用户偏好建模（Honcho dialectic）      │
│  - 会话历史检索（FTS5）                  │
│  - 上下文自动压缩                        │
└─────────────────────────────────────────┘
```

### 2.2 技能生成流程

```typescript
// Hermes 伪代码（基于文档推断）
class HermesAgent {
  private skillRegistry: Map<string, Skill>;
  private sessionMemory: SessionStore;
  private userModel: HonchoDialectic;
  
  async executeTask(task: string): Promise<Result> {
    // 1. 检索相关技能
    const relevantSkills = this.findApplicableSkills(task);
    
    // 2. 执行任务
    const result = await this.runWithSkills(task, relevantSkills);
    
    // 3. 🔑 任务完成后自动反思
    if (result.isComplex && result.successful) {
      const newSkill = await this.synthesizeSkill({
        task,
        solution: result.steps,
        context: this.sessionMemory.getRecentContext()
      });
      
      // 4. 持久化新技能
      await this.skillRegistry.persist(newSkill);
      
      // 5. 兼容 agentskills.io 标准（可分享）
      await this.exportToStandard(newSkill);
    }
    
    return result;
  }
  
  async improveSkillFromUsage(skill: Skill, outcome: Outcome) {
    // 🔑 技能在实际使用中自我改进
    if (outcome.failed) {
      skill.refine(outcome.error, outcome.context);
      skill.successRate = this.recalculate(skill.usageHistory);
    }
  }
}
```

**关键特性**：
- ✅ **自动触发**：复杂任务完成后，Agent 主动提取技能
- ✅ **持久化**：技能存储到本地数据库，跨会话可用
- ✅ **自我改进**：技能在使用中根据成功/失败反馈优化
- ✅ **可分享**：兼容开源标准，技能可导入/导出

---

## 三、LoopAgent 当前状态

### 3.1 现有能力

#### ✅ 项目记忆系统（已实现但未集成）

```typescript
// src/extension/memory/projectMemory.ts
class ProjectMemory {
  // 支持三种记忆类型
  async remember(input: {
    kind: "fact" | "decision" | "lesson";  // ← lesson 类似技能
    subject: string;
    content: string;
    evidence: MemoryEvidence[];
  }): Promise<WriteResult>;
  
  // 记录运行结果
  async recordOutcome(outcome: ReactAgentRunOutcome): Promise<void>;
}
```

**问题**：
- ❌ 子代理（subagent）**不读取**项目记忆（见规范："子代理 system prompt 只包含运行时上下文，不读取或写入项目记忆"）
- ❌ 记忆是**被动的**（需要主 Agent 显式调用 `remember`），不会自动从成功任务中提取
- ❌ `lesson` 类型存在但无自动生成机制

#### ✅ 工作流编排（已实现）

```typescript
// src/extension/agent/workflowOrchestrator.ts
class WorkflowOrchestrator {
  createSubagent(config: {
    task: string;
    role?: "explorer" | "reviewer" | "planner";
    dependsOn?: string[];  // DAG 依赖
  }): string;
  
  waitForSubagents(ids: string[]): Promise<Map<string, SubagentResult>>;
}
```

**特点**：
- ✅ DAG 验证、并发控制、超时管理
- ✅ 子代理隔离（只读工具、无递归权限）
- ❌ **单次运行**：orchestrator 生命周期 = 一次主 Agent 调用
- ❌ 子代理结果不持久化为可复用知识

### 3.2 缺失的环节

```
当前状态：
┌──────────┐    ┌──────────┐    ┌──────────┐
│ 主 Agent │───►│ 子代理 A  │───►│ 结果丢弃 │
└──────────┘    └──────────┘    └──────────┘
                       │
                       ▼
                ┌──────────┐
                │ 子代理 B  │
                └──────────┘

Hermes 状态：
┌──────────┐    ┌──────────┐    ┌─────────────┐
│ 主 Agent │───►│ 子代理 A  │───►│ 技能提取器   │
└──────────┘    └──────────┘    └──────┬──────┘
                       │                │
                       ▼                ▼
                ┌──────────┐    ┌──────────────┐
                │ 子代理 B  │    │ 技能注册表    │
                └──────────┘    │ (持久化)      │
                                └──────┬──────┘
                                       │
                       ┌───────────────┘
                       ▼
                下次调用自动使用
```

---

## 四、差距分析

### 4.1 核心差距：单次 vs 持续

| 场景 | LoopAgent 行为 | Hermes 行为 |
|------|---------------|------------|
| **任务 1**：重构复杂类 | 创建 3 个子代理完成 → 销毁 orchestrator | 同左 + 生成"类重构"技能并保存 |
| **任务 2**：重构另一个类 | 重新创建子代理，从头执行 | 检索到"类重构"技能 → 直接应用（快 10 倍） |
| **任务 3**：重构失败 | 用户看到错误，无后续 | "类重构"技能自动优化，下次避免此错误 |
| **一周后** | 记忆系统可能有 `lesson`，但需要主 Agent 主动读取 | 技能自动加载，无需提示 |

### 4.2 技术债务

#### 已有但未连接的组件

```typescript
// ❌ 问题 1：记忆系统与子代理隔离
// src/extension/agent/workflowOrchestrator.ts:119
const runner = await options.createRunner({
  subagentId: snapshot.id,
  task: snapshot.task,  // ← 只传递纯任务文本
  role: snapshot.role,
  signal: controller.signal,
  tools: snapshot.tools,
});
// 缺失：没有注入 ProjectMemory 上下文

// ❌ 问题 2：结果不自动转化为 lesson
// src/extension/agent/workflowOrchestrator.ts:148
settle(entry, { 
  status: "completed", 
  content  // ← 结果只返回给主 Agent，不持久化
});
// 缺失：没有调用 ProjectMemory.recordOutcome()

// ❌ 问题 3：记忆写入是手动的
// src/extension/memory/projectMemory.ts:99
async recordOutcome(outcome: ReactAgentRunOutcome): Promise<void> {
  // 这个函数存在，但没有人在子代理完成时调用它
}
```

---

## 五、实现自我进化的路径

### 路径 A：最小化改动（2-3 天）

**目标**：让子代理结果自动转化为项目记忆

```typescript
// 1. 修改 WorkflowOrchestrator.settle()
async function settle(entry: SubagentEntry, result: SubagentResult): Promise<void> {
  // ... 现有代码 ...
  
  // 🆕 自动记录成功经验
  if (result.status === "completed" && result.content) {
    await projectMemory.recordOutcome({
      runId: snapshot.id,
      task: snapshot.task,
      status: "completed",
      finalContent: result.content,
      evidence: extractEvidenceFromMessages(entry.messages)
    });
  }
}

// 2. 在 createRunner 时注入记忆上下文
const runner = await options.createRunner({
  subagentId: snapshot.id,
  task: snapshot.task,
  role: snapshot.role,
  memoryContext: await projectMemory.loadContext(snapshot.task), // 🆕
  signal: controller.signal,
  tools: snapshot.tools,
});
```

**效果**：
- ✅ 子代理成功执行 → 自动保存为 `lesson`
- ✅ 下次类似任务 → 主 Agent 可以读取 lesson 并传递给新子代理
- ⚠️ 但还不是"真正的技能"（需要主 Agent 手动传递上下文）

### 路径 B：完整技能系统（1-2 周）

**设计**：参考 Hermes 的技能注册表

```typescript
// 新增：src/extension/agent/skillRegistry.ts
type Skill = {
  id: string;
  name: string;
  description: string;
  applicableWhen: (task: string) => Promise<boolean>;  // LLM 判断
  execute: (task: string, tools: Tool[]) => Promise<SubagentResult>;
  metadata: {
    createdAt: Date;
    usageCount: number;
    successRate: number;
    lastUsed?: Date;
  };
};

class SkillRegistry {
  private skills = new Map<string, Skill>();
  
  // 🔑 从成功的子代理执行中生成技能
  async synthesizeFromExecution(
    task: string,
    result: SubagentResult,
    messages: ReactAgentMessage[]
  ): Promise<Skill | null> {
    // 调用 LLM 分析执行轨迹
    const analysis = await this.llm.analyze({
      prompt: `
        分析以下任务执行，判断是否值得提取为可复用技能：
        
        任务：${task}
        执行步骤：${this.summarizeMessages(messages)}
        结果：${result.content}
        
        如果这个任务模式可复用，生成：
        1. 技能名称
        2. 适用场景描述
        3. 执行步骤模板
      `
    });
    
    if (!analysis.worthExtracting) return null;
    
    return {
      id: generateId(),
      name: analysis.name,
      description: analysis.description,
      applicableWhen: this.compileApplicabilityCheck(analysis.pattern),
      execute: this.compileExecutionTemplate(analysis.steps),
      metadata: {
        createdAt: new Date(),
        usageCount: 0,
        successRate: 1.0,
        lastUsed: undefined
      }
    };
  }
  
  // 🔑 执行前匹配技能
  async findApplicableSkills(task: string): Promise<Skill[]> {
    const applicable: Skill[] = [];
    for (const skill of this.skills.values()) {
      if (await skill.applicableWhen(task)) {
        applicable.push(skill);
      }
    }
    return applicable.sort((a, b) => 
      b.metadata.successRate - a.metadata.successRate
    );
  }
  
  // 🔑 使用后更新成功率
  updateFromOutcome(skillId: string, success: boolean): void {
    const skill = this.skills.get(skillId);
    if (!skill) return;
    
    const { usageCount, successRate } = skill.metadata;
    skill.metadata.usageCount++;
    skill.metadata.successRate = 
      (successRate * usageCount + (success ? 1 : 0)) / (usageCount + 1);
    skill.metadata.lastUsed = new Date();
  }
}
```

**集成点**：

```typescript
// 修改 WorkflowOrchestrator
class WorkflowOrchestrator {
  constructor(
    private skillRegistry: SkillRegistry,  // 🆕
    ...
  ) {}
  
  async createSubagent(config: CreateSubagentConfig): string {
    // 🆕 1. 检查是否有可用技能
    const skills = await this.skillRegistry.findApplicableSkills(config.task);
    
    if (skills.length > 0) {
      // 直接使用技能执行（跳过 LLM 调用）
      const skill = skills[0];
      const result = await skill.execute(config.task, availableTools);
      
      // 更新技能统计
      this.skillRegistry.updateFromOutcome(
        skill.id, 
        result.status === "completed"
      );
      
      return this.wrapSkillExecution(skill, result);
    }
    
    // 2. 没有技能，正常执行子代理
    const id = await this.normalSubagentExecution(config);
    
    return id;
  }
  
  private async settle(entry: SubagentEntry, result: SubagentResult) {
    // ... 现有代码 ...
    
    // 🆕 3. 尝试从成功执行中提取技能
    if (result.status === "completed" && shouldExtractSkill(entry)) {
      const skill = await this.skillRegistry.synthesizeFromExecution(
        entry.context.snapshot().task,
        result,
        entry.messages
      );
      
      if (skill) {
        await this.skillRegistry.persist(skill);
        this.emit({ 
          type: "SkillCreated", 
          skillId: skill.id, 
          name: skill.name 
        });
      }
    }
  }
}

function shouldExtractSkill(entry: SubagentEntry): boolean {
  // 启发式规则：
  // - 执行时间 > 10秒（足够复杂）
  // - 工具调用 > 3 次
  // - 任务描述包含"重构"、"迁移"等关键词
  const duration = entry.context.snapshot().finishedAt!.getTime() - 
                   entry.context.snapshot().startedAt!.getTime();
  return duration > 10_000 && 
         (entry.result.toolCallCount ?? 0) > 3;
}
```

**效果**：
- ✅ **第一次**：任务 A 执行成功 → 自动生成"技能 X"
- ✅ **第二次**：任务 B 相似 → 匹配到"技能 X" → 直接执行（无需 LLM 推理）
- ✅ **失败时**："技能 X"成功率下降 → 下次降低优先级或触发重新训练
- ✅ **跨会话**：技能持久化到 SQLite，重启后仍可用

### 路径 C：完全对标 Hermes（1-2 月）

额外增加：

1. **工具动态生成**：
   - 让 Agent 写 TypeScript 代码来创建新工具
   - 沙盒执行（`vm2` 或 Deno）
   - 工具也进入注册表，像技能一样复用

2. **用户建模**：
   - 集成类似 Honcho 的 dialectic 系统
   - 学习用户偏好、编码风格、项目约定
   - 自动调整 Agent 行为

3. **元学习**：
   - 技能生成器本身可进化
   - A/B 测试不同的技能提取策略
   - 强化学习优化技能选择

---

## 六、建议优先级

### 🥇 立即实施（路径 A）

**投入**：2-3 天  
**收益**：中等（子代理结果可复用，但需要手动触发）  
**风险**：低（只修改现有代码）

**行动项**：
1. ✅ 修改 `WorkflowOrchestrator.settle()` 调用 `ProjectMemory.recordOutcome()`
2. ✅ 在 `createRunner()` 时注入 `memoryContext`
3. ✅ 添加集成测试验证记忆写入

### 🥈 中期目标（路径 B）

**投入**：1-2 周  
**收益**：高（真正的自我进化）  
**风险**：中（需要新架构组件）

**里程碑**：
- Week 1：实现 `SkillRegistry` 基础结构
- Week 2：集成到 `WorkflowOrchestrator`，验证技能复用

### 🥉 长期愿景（路径 C）

**投入**：1-2 月  
**收益**：极高（完全对标 Hermes）  
**风险**：高（涉及代码生成、沙盒、强化学习）

**解锁能力**：
- Agent 可以自己"写插件"
- 用户个性化建模
- 技能可导出/分享到社区

---

## 七、关键设计决策

### 7.1 技能存储格式

```typescript
// 方案 A：存储执行轨迹（简单）
type SkillV1 = {
  id: string;
  name: string;
  taskPattern: string;  // "重构包含 X 的类"
  executionTrace: {
    step: number;
    tool: string;
    input: any;
    output: any;
  }[];
};

// 方案 B：存储参数化模板（灵活）
type SkillV2 = {
  id: string;
  name: string;
  applicabilityCheck: string;  // JavaScript 表达式
  executionPlan: {
    step: number;
    tool: string;
    inputTemplate: string;  // 可替换变量
  }[];
};

// 方案 C：存储 TypeScript 代码（最强）
type SkillV3 = {
  id: string;
  name: string;
  code: string;  // 完整的 TS 函数
  signature: {
    input: JSONSchema;
    output: JSONSchema;
  };
};
```

**推荐**：先实现方案 A（最简单），逐步演进到方案 C。

### 7.2 技能触发时机

```typescript
// 选项 1：替代子代理（Hermes 方式）
if (hasApplicableSkill(task)) {
  return await skill.execute(task);  // 快速路径
} else {
  return await createSubagent(task);  // 慢速路径
}

// 选项 2：辅助子代理（保守方式）
const skill = findApplicableSkill(task);
const subagentPrompt = skill 
  ? `${task}\n\n参考成功经验：${skill.description}`
  : task;
return await createSubagent(subagentPrompt);
```

**推荐**：先实现选项 2（风险低），验证后升级到选项 1。

---

## 八、总结

| 方面 | 当前状态 | 与 Hermes 差距 | 实现难度 |
|------|---------|---------------|---------|
| **记忆系统** | ✅ 已有但隔离 | 需要集成到子代理 | 🟢 简单 |
| **技能生成** | ❌ 无 | 需要从头实现 | 🟡 中等 |
| **技能持久化** | ❌ 无 | 复用现有 SQLite | 🟢 简单 |
| **技能复用** | ❌ 无 | 需要匹配引擎 | 🟡 中等 |
| **工具生成** | ❌ 无 | 需要沙盒执行 | 🔴 困难 |
| **用户建模** | ❌ 无 | 需要新系统 | 🔴 困难 |

**核心洞察**：
1. LoopAgent **已有 80% 的基础设施**（记忆、子代理、工具）
2. 缺失的是**连接层**（自动触发、技能提取、复用引擎）
3. 最快路径是**将现有组件串联**，而非重写

**下一步**：你希望我实现哪条路径？
- 路径 A（快速验证）
- 路径 B（完整技能系统）
- 或者先看一个具体的代码原型？
