/**
 * 自动恢复系统集成示例
 *
 * 展示如何将 SmartCommandExecutor 和 AutoRecoveryOrchestrator
 * 集成到 LoopAgent 的工具层
 */

import * as vscode from 'vscode';
import { SmartCommandExecutor, CommandResult } from './smartCommandExecutor';
import { AutoRecoveryOrchestrator, Task, TaskContext } from './autoRecoveryOrchestrator';

// ==================== 集成到 runCommand 工具 ====================

/**
 * 增强的 runCommand 工具（替换现有实现）
 */
export async function runCommandWithAutoRecovery(
	command: string,
	cwd?: string,
	options?: {
		timeout?: number;
		maxAttempts?: number;
	}
): Promise<string> {
	const workspaceRoot = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
	const executor = new SmartCommandExecutor();

	// 执行命令（带自动恢复）
	const result = await executor.executeWithAutoRecovery(command, workspaceRoot, {
		timeout: options?.timeout,
		maxAttempts: options?.maxAttempts,
		allowAlternatives: true,
	});

	// 格式化返回给 LLM
	return formatResultForLLM(result);
}

/**
 * 格式化结果为 LLM 可读的 Markdown
 */
function formatResultForLLM(result: CommandResult): string {
	if (result.success) {
		// 成功：返回输出
		return `✅ 命令执行成功\n\n\`\`\`\n${result.stdout}\n\`\`\``;
	}

	// 失败：返回错误信息和备选方案
	const lines: string[] = [];

	lines.push(`❌ 命令执行失败`);
	lines.push(``);
	lines.push(`**错误类型**: ${result.error?.type}`);
	lines.push(`**错误信息**: ${result.error?.message}`);

	if (result.stderr) {
		lines.push(``);
		lines.push(`**错误详情**:`);
		lines.push(`\`\`\``);
		lines.push(result.stderr.substring(0, 1000)); // 限制长度
		lines.push(`\`\`\``);
	}

	// 显示备选方案
	if (result.error?.alternatives && result.error.alternatives.length > 0) {
		lines.push(``);
		lines.push(`## 🔀 可用的备选方案`);
		lines.push(``);

		const autoAlts = result.error.alternatives.filter((alt) => alt.automation === 'auto');

		if (autoAlts.length > 0) {
			lines.push(`以下方案可以自动执行（按成功概率排序）：`);
			lines.push(``);

			autoAlts.forEach((alt, i) => {
				const prob = (alt.successProbability * 100).toFixed(0);
				const risk = alt.risk ? ` [风险: ${alt.risk}]` : '';
				lines.push(`${i + 1}. **${alt.description}** (成功率: ${prob}%)${risk}`);

				// 显示具体命令
				if (alt.action.type === 'command') {
					lines.push(`   \`${alt.action.payload.command}\``);
				}
			});

			lines.push(``);
			lines.push(
				`💡 **建议**: 直接尝试第一个备选方案（成功率最高）。如果失败，依次尝试后续方案。`
			);
		}
	}

	return lines.join('\n');
}

// ==================== 集成到 Agent 工具集 ====================

/**
 * 注册到 Agent 的工具集
 */
export function registerAutoRecoveryTools() {
	return {
		runCommand: {
			name: 'runCommand',
			description: `执行 shell 命令（带自动错误恢复）。

**自动恢复能力**：
- 命令不存在 → 自动切换到备选命令（如 mvn → mvnw → gradle）
- 依赖下载失败 → 自动尝试跳过测试、清理缓存等
- 超时 → 自动增加超时时间或后台执行
- 权限不足 → 自动修改权限或使用当前用户
- 输出过大 → 自动重定向到文件

**重要**：工具返回的备选方案已按成功率排序，直接尝试即可。

**示例**：
输入: runCommand("mvn install", "/path/to/project")
输出（失败时）:
  - 错误信息
  - 备选方案1: 使用 mvnw (成功率 95%)
  - 备选方案2: 使用 gradle (成功率 80%)

你应该：
1. 读取第一个备选方案
2. 直接执行该方案（无需询问用户）
3. 如果仍失败，尝试下一个方案`,

			handler: runCommandWithAutoRecovery,
		},

		buildProject: {
			name: 'buildProject',
			description: `构建项目（自动选择构建工具）。

**自动策略**：
1. Maven (mvn clean install)
2. Maven Wrapper (./mvnw clean install)
3. Gradle (./gradlew build)
4. npm (npm run build)
5. 跳过构建，继续代码分析

**使用场景**：
- 用户要求"编译项目"
- 需要验证代码修改是否正确
- 在代码分析前先构建

**优势**：
- 无需手动判断使用哪个构建工具
- 自动尝试多个策略直到成功
- 失败后不会陷入死循环`,

			handler: async (workspaceRoot?: string) => {
				const orchestrator = new AutoRecoveryOrchestrator();
				const task: Task = {
					description: '构建项目',
					type: 'build',
					params: {},
				};

				const context: TaskContext = {
					workspaceRoot: workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
					executor: new SmartCommandExecutor(),
				};

				const result = await orchestrator.executeTask(task, context);
				return formatTaskResultForLLM(result);
			},
		},

		runTests: {
			name: 'runTests',
			description: `运行测试（自动选择测试工具）。

**自动策略**：
1. Maven 测试 (mvn test)
2. npm 测试 (npm test)
3. Gradle 测试 (./gradlew test)
4. 跳过测试

适用场景：验证代码修改是否破坏现有功能`,

			handler: async (workspaceRoot?: string) => {
				const orchestrator = new AutoRecoveryOrchestrator();
				const task: Task = {
					description: '运行测试',
					type: 'test',
					params: {},
				};

				const context: TaskContext = {
					workspaceRoot: workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
					executor: new SmartCommandExecutor(),
				};

				const result = await orchestrator.executeTask(task, context);
				return formatTaskResultForLLM(result);
			},
		},
	};
}

/**
 * 格式化任务结果为 LLM 可读格式
 */
function formatTaskResultForLLM(result: any): string {
	if (result.success) {
		return `✅ ${result.summary}\n\n${result.output || ''}`;
	}

	const lines: string[] = [];
	lines.push(`❌ ${result.summary || '任务失败'}`);
	lines.push(``);

	if (result.attemptedStrategies && result.attemptedStrategies.length > 0) {
		lines.push(`**已尝试的策略**:`);
		result.attemptedStrategies.forEach((s: string, i: number) => {
			lines.push(`  ${i + 1}. ${s}`);
		});
		lines.push(``);
	}

	if (result.needsUserIntervention) {
		lines.push(`⚠️  **需要人工干预**`);
		lines.push(`所有自动化策略都失败了。建议检查环境配置或请求用户手动执行。`);
	}

	return lines.join('\n');
}

// ==================== System Prompt 增强 ====================

export const AUTO_RECOVERY_SYSTEM_PROMPT = `
# 自动错误恢复机制

你现在拥有**自动错误恢复**能力。当工具返回失败时，你可以自主决策并切换策略。

## 核心原则

1. **静默执行** — 在备选方案之间切换时保持静默，不要向用户报告每次尝试
2. **概率驱动** — 优先尝试成功率 >70% 的方案，跳过 <40% 的方案
3. **快速放弃** — 同一错误最多尝试 3 个备选方案，然后放弃或请求人工
4. **无破坏性** — 自动执行的方案必须是低风险的（risk: 'low' 或 'medium'）

## 处理流程

当 \`runCommand\` 返回失败时：

\`\`\`
{
  "success": false,
  "error": {
    "type": "not_found",
    "message": "mvn 命令未找到",
    "alternatives": [
      {
        "description": "使用 Maven Wrapper (mvnw)",
        "automation": "auto",
        "successProbability": 0.95,
        "risk": "low",
        "action": { "type": "command", "payload": { "command": "./mvnw clean install" } }
      },
      {
        "description": "使用 Gradle 构建",
        "automation": "auto",
        "successProbability": 0.8,
        "risk": "low",
        "action": { "type": "command", "payload": { "command": "./gradlew build" } }
      }
    ]
  }
}
\`\`\`

### ✅ 正确响应（自动执行）

\`\`\`
思考: Maven 未找到，备选方案1是 mvnw (95%成功率，低风险)，直接执行
行动: runCommand("./mvnw clean install", workspaceRoot)
\`\`\`

### ❌ 错误响应（过度报告）

\`\`\`
回复: "Maven 命令未找到。我发现了2个备选方案：
1. 使用 Maven Wrapper
2. 使用 Gradle
您希望我尝试哪一个？"
\`\`\`

**为什么错误**：用户不关心过程，只关心结果。直接执行高概率方案即可。

## 决策规则

| 成功率 | 风险 | 行动 |
|--------|------|------|
| >0.7 | low | ✅ 直接执行，无需报告 |
| >0.7 | medium | ✅ 直接执行，简短告知 |
| >0.7 | high | ⚠️ 简短说明风险，然后执行 |
| 0.4-0.7 | low | ✅ 评估副作用后执行 |
| 0.4-0.7 | medium/high | ⚠️ 向用户确认 |
| <0.4 | any | ❌ 跳过，尝试下一个 |

## 示例场景

### 场景1：编译失败（依赖问题）

\`\`\`
用户: "帮我编译整个项目"

第1次: runCommand("mvn install")
返回: { success: false, alternatives: [
  { description: "跳过测试", probability: 0.7 },
  { description: "清理缓存", probability: 0.6 }
]}

你的响应: "依赖下载失败，尝试跳过测试加速构建。"
第2次: runCommand("mvn install -DskipTests")
返回: { success: true }

你的响应: "✅ 编译成功（跳过了测试）。"
\`\`\`

**关键点**：
- 只在切换策略时简短说明（一句话）
- 成功后只汇报结果，不列举尝试过的方案

### 场景2：所有方案都失败

\`\`\`
第1次: runCommand("mvn install") → 失败
第2次: runCommand("./mvnw install") → 失败
第3次: runCommand("./mvnw install -DskipTests") → 失败

你的响应:
"❌ 编译失败。已尝试 Maven、Maven Wrapper、跳过测试，均失败。
错误原因：依赖 com.tch.cloud 无法下载。
建议：检查 settings.xml 中的仓库配置和访问凭据。"
\`\`\`

## 禁止行为

❌ 不要在每次切换方案时都询问用户
❌ 不要在尝试前详细解释每个方案的原理
❌ 不要在成功后总结"我尝试了 X、Y、Z 三种方案"
❌ 不要对同一命令重试超过 3 次
✅ 保持静默，快速尝试，仅在成功或全部失败时简短汇报
`;

// ==================== 使用示例 ====================

export async function exampleUsage() {
	console.log('=== 自动恢复系统使用示例 ===\n');

	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

	// 示例1：使用 SmartCommandExecutor
	console.log('示例1：智能命令执行');
	const executor = new SmartCommandExecutor();
	const result1 = await executor.executeWithAutoRecovery('mvn clean install', workspaceRoot);
	console.log('结果:', result1.success ? '成功' : '失败');
	if (!result1.success && result1.error?.alternatives) {
		console.log(`备选方案: ${result1.error.alternatives.length} 个`);
	}

	// 示例2：使用 AutoRecoveryOrchestrator
	console.log('\n示例2：自动恢复编排器');
	const orchestrator = new AutoRecoveryOrchestrator();
	const task: Task = {
		description: '构建项目',
		type: 'build',
		params: {},
	};
	const context: TaskContext = {
		workspaceRoot,
		executor: new SmartCommandExecutor(),
	};
	const result2 = await orchestrator.executeTask(task, context);
	console.log('结果:', result2.summary);

	// 示例3：集成到工具
	console.log('\n示例3：集成工具调用');
	const formattedResult = await runCommandWithAutoRecovery('npm test', workspaceRoot);
	console.log('LLM 看到的结果:\n', formattedResult);
}
