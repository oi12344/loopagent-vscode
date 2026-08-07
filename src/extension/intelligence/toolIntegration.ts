/**
 * LoopAgent 工具集成：增强的引用发现和安全删除
 *
 * 将多层防御策略集成到 exploreCode 工具中，
 * 并提供新的 safeDeleteInterface 工具供 Agent 使用
 */

import { MultiLayerReferenceDiscovery, Reference } from './referenceDiscovery';
import { SafeDeleteOrchestrator } from './safeDeleteOrchestrator';
import { SqliteIndexWorkerClient } from './storage/sqliteIndexWorkerClient';
import { getTreeSitterParser } from './parser/treeSitterRuntime';

/**
 * 增强的 exploreCode 工具（带多层降级）
 */
export async function exploreCodeWithFallback(
	query: string,
	workspaceRoot: string,
	indexClient: SqliteIndexWorkerClient
): Promise<string> {
	const discovery = new MultiLayerReferenceDiscovery(
		workspaceRoot,
		indexClient,
		getTreeSitterParser
	);

	try {
		// 提取符号名称（简单实现，实际应更智能）
		const symbolMatch = query.match(/\b([A-Z][a-zA-Z0-9_]*(?:VO|Service|Controller|Mapper)?)\b/);
		const symbol = symbolMatch ? symbolMatch[1] : query;

		console.log(`[exploreCodeWithFallback] 查询: ${query}, 提取符号: ${symbol}`);

		// 使用多层策略查找引用
		const references = await discovery.findAllReferences(symbol, {
			language: 'java',
			filePattern: '*.java',
			includeGitHistory: false,
		});

		if (references.length === 0) {
			return '未命中代码上下文。';
		}

		// 格式化为 Markdown 返回给 Agent
		return formatReferencesAsMarkdown(query, references);
	} catch (error) {
		console.error('[exploreCodeWithFallback] 失败:', error);
		return `代码搜索失败: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * 格式化引用为 Markdown
 */
function formatReferencesAsMarkdown(query: string, references: Reference[]): string {
	const lines: string[] = [];

	lines.push('## 代码语义索引上下文');
	lines.push('');
	lines.push(`查询: ${query}`);
	lines.push('');

	// 按文件分组
	const fileGroups = new Map<string, Reference[]>();
	for (const ref of references) {
		if (!fileGroups.has(ref.file)) {
			fileGroups.set(ref.file, []);
		}
		fileGroups.get(ref.file)!.push(ref);
	}

	// 按来源统计
	const sourceStats = references.reduce((acc, r) => {
		acc[r.source] = (acc[r.source] || 0) + 1;
		return acc;
	}, {} as Record<string, number>);

	lines.push(`### 搜索策略`);
	lines.push('');
	for (const [source, count] of Object.entries(sourceStats)) {
		const strategyName = {
			index: '索引查询',
			ast: 'AST 分析',
			text: '文本扫描',
			git: 'Git 历史',
		}[source] || source;
		lines.push(`- **${strategyName}**: ${count} 个引用`);
	}
	lines.push('');

	lines.push('### 精确符号匹配');
	lines.push('');

	for (const [file, refs] of fileGroups.entries()) {
		lines.push(`#### 📄 ${file}`);
		lines.push('');

		for (const ref of refs) {
			const typeLabel = {
				import: '📦 import',
				type: '🏷️  type',
				variable: '📌 variable',
				method_call: '🔧 method_call',
				inheritance: '🧬 inheritance',
				instantiation: '✨ instantiation',
				unknown: '❓ unknown',
			}[ref.type] || ref.type;

			lines.push(`- **${typeLabel}** (行 ${ref.line})`);
			lines.push(`  \`\`\`java`);
			lines.push(`  ${ref.context}`);
			lines.push(`  \`\`\``);
			lines.push('');
		}
	}

	return lines.join('\n');
}

/**
 * 新工具：安全删除接口
 *
 * Agent 可以直接调用此工具来删除接口及其所有引用
 */
export async function safeDeleteInterface(
	symbolName: string,
	workspaceRoot: string,
	indexClient: SqliteIndexWorkerClient,
	options: {
		requireConfirmation?: boolean;
		dryRun?: boolean;
	} = {}
): Promise<string> {
	const { requireConfirmation = true, dryRun = false } = options;

	try {
		const discovery = new MultiLayerReferenceDiscovery(
			workspaceRoot,
			indexClient,
			getTreeSitterParser
		);

		const orchestrator = new SafeDeleteOrchestrator(discovery, workspaceRoot);

		if (dryRun) {
			// 仅分析，不实际删除
			const plan = await discovery.buildDeletionPlan(symbolName);

			if (plan.references.length === 0) {
				return `未找到 ${symbolName} 的任何引用。可能已被删除或从未创建。`;
			}

			const lines: string[] = [];
			lines.push(`## 删除计划预览: ${symbolName}`);
			lines.push('');
			lines.push(`**影响范围:**`);
			lines.push(`- 文件数: ${plan.impact.fileCount}`);
			lines.push(`- 引用数: ${plan.impact.lineCount}`);
			lines.push(`- 风险等级: ${plan.impact.risk.toUpperCase()}`);
			lines.push('');
			lines.push(`**引用列表:**`);

			for (const ref of plan.references) {
				lines.push(`- \`${ref.file}:${ref.line}\` [${ref.type}] ${ref.context}`);
			}

			lines.push('');
			lines.push('> 💡 这是预览模式，未执行任何删除操作。');

			return lines.join('\n');
		}

		// 实际执行删除
		const result = await orchestrator.deleteInterfaceWithReferences(symbolName, {
			requireConfirmation,
			includeGitHistory: false,
			filePattern: '*.java',
			autoSave: true,
		});

		if (result.success) {
			return `✅ 成功删除 ${symbolName} 及其 ${result.appliedOperations.length} 处引用。\n\n修改的文件:\n${[...new Set(result.appliedOperations.map((op) => `- ${op.file}`))].join('\n')}`;
		} else {
			return `❌ 删除失败: ${result.error?.message}。已回滚所有更改。`;
		}
	} catch (error) {
		console.error('[safeDeleteInterface] 失败:', error);
		return `删除失败: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * 工具描述（供 Agent 的 system prompt 使用）
 */
export const TOOL_DESCRIPTIONS = {
	exploreCodeWithFallback: {
		name: 'exploreCode',
		description: `搜索当前工作区中与问题相关的代码。

使用4层策略确保找到所有引用：
1. 索引查询（最快，<10ms）
2. AST 语法树分析（精确，~2-5秒）
3. 文本全量扫描（兜底，~500ms）
4. Git 历史回溯（处理已删除文件）

返回 Markdown 格式的代码上下文，包括文件路径、行号、引用类型。`,
		parameters: {
			query: '要搜索的符号名称或代码片段（如 "MessageSendVO" 或 "addMessage 使用"）',
		},
	},

	safeDeleteInterface: {
		name: 'safeDeleteInterface',
		description: `安全删除接口/类及其所有引用。

自动执行以下步骤：
1. 使用多层策略查找所有引用（import、使用、继承等）
2. 分析依赖关系和影响范围
3. 向用户展示删除计划（影响的文件、行数、风险等级）
4. 等待用户确认
5. 事务性删除（全部成功或全部回滚）

适用场景：
- 删除不再需要的 VO/DTO 类
- 删除废弃的 Service 接口
- 清理未使用的工具类

⚠️ 注意：此工具会修改多个文件，建议先使用 dryRun 模式预览。`,
		parameters: {
			symbolName: '要删除的符号名称（如 "MessageSendVO"）',
			options: {
				requireConfirmation: '是否需要用户确认（默认 true）',
				dryRun: '仅预览删除计划，不实际执行（默认 false）',
			},
		},
	},
};

/**
 * 使用示例（供测试）
 */
export async function exampleUsage() {
	// 示例1：搜索符号引用
	const workspaceRoot = '/d/zz/yguc';
	const indexClient = null as any; // 实际使用时需要初始化

	console.log('示例1：搜索 MessageSendVO 的所有引用');
	const searchResult = await exploreCodeWithFallback('MessageSendVO', workspaceRoot, indexClient);
	console.log(searchResult);

	// 示例2：预览删除计划
	console.log('\n示例2：预览删除 MessageSendVO 的计划');
	const previewResult = await safeDeleteInterface('MessageSendVO', workspaceRoot, indexClient, {
		dryRun: true,
	});
	console.log(previewResult);

	// 示例3：实际执行删除（需要用户确认）
	console.log('\n示例3：执行删除 MessageSendVO');
	const deleteResult = await safeDeleteInterface('MessageSendVO', workspaceRoot, indexClient, {
		requireConfirmation: true,
	});
	console.log(deleteResult);
}
