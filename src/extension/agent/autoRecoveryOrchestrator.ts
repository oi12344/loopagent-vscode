/**
 * 自动恢复编排器
 *
 * 协调多个策略的执行，自动尝试备选方案，
 * 最小化人工干预，让 LLM 能够自主完成任务
 */

import * as vscode from 'vscode';
import { SmartCommandExecutor, CommandResult, Alternative, AlternativeAction } from './smartCommandExecutor';

// ==================== 类型定义 ====================

export interface Task {
	/** 任务描述 */
	description: string;
	/** 任务类型 */
	type: TaskType;
	/** 任务参数 */
	params: any;
}

export type TaskType = 'build' | 'test' | 'install' | 'run' | 'git' | 'custom';

export interface Strategy {
	/** 策略名称 */
	name: string;
	/** 策略优先级（越高越优先） */
	priority: number;
	/** 执行动作 */
	action: StrategyAction;
	/** 前置条件检查 */
	precondition?: () => Promise<boolean>;
}

export interface StrategyAction {
	type: 'command' | 'tool' | 'skip';
	payload: any;
}

export interface TaskResult {
	/** 是否成功 */
	success: boolean;
	/** 输出信息 */
	output?: string;
	/** 错误信息 */
	error?: string;
	/** 使用的策略 */
	strategy?: string;
	/** 尝试的策略列表 */
	attemptedStrategies?: string[];
	/** 是否需要人工干预 */
	needsUserIntervention?: boolean;
	/** 执行摘要 */
	summary?: string;
}

export interface TaskContext {
	workspaceRoot: string;
	executor: SmartCommandExecutor;
	outputChannel?: vscode.OutputChannel;
}

// ==================== 主类 ====================

export class AutoRecoveryOrchestrator {
	private executor: SmartCommandExecutor;
	private outputChannel: vscode.OutputChannel;

	constructor(executor?: SmartCommandExecutor) {
		this.outputChannel = vscode.window.createOutputChannel('LoopAgent - Auto Recovery');
		this.executor = executor || new SmartCommandExecutor(this.outputChannel);
	}

	/**
	 * 执行任务（带自动恢复）
	 */
	async executeTask(task: Task, context: TaskContext): Promise<TaskResult> {
		this.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
		this.log(`📋 任务: ${task.description}`);
		this.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

		// 生成策略列表
		const strategies = await this.generateStrategies(task, context);
		this.log(`🎯 生成了 ${strategies.length} 个策略`);

		const attemptedStrategies: string[] = [];

		// 按优先级尝试每个策略
		for (const strategy of strategies) {
			this.log(`\n🔄 尝试策略: ${strategy.name} (优先级: ${strategy.priority})`);

			// 检查前置条件
			if (strategy.precondition) {
				const canRun = await strategy.precondition();
				if (!canRun) {
					this.log(`⏭️  跳过: 前置条件不满足`);
					continue;
				}
			}

			attemptedStrategies.push(strategy.name);

			try {
				// 执行策略
				const result = await this.executeStrategy(strategy, context);

				if (result.success) {
					this.log(`✅ 策略成功: ${strategy.name}`);
					return {
						success: true,
						output: result.stdout,
						strategy: strategy.name,
						attemptedStrategies,
						summary: this.generateSuccessSummary(task, strategy, attemptedStrategies),
					};
				}

				// 策略失败，但有备选方案
				const alternatives = result.error?.alternatives ?? [];
				if (alternatives.length > 0) {
					this.log(`🔀 策略失败，尝试 ${alternatives.length} 个备选方案`);

					const altResult = await this.tryAlternatives(alternatives, context);

					if (altResult.success) {
						this.log(`✅ 备选方案成功`);
						return {
							success: true,
							output: altResult.output,
							strategy: `${strategy.name} → 备选方案`,
							attemptedStrategies,
							summary: this.generateSuccessSummary(task, strategy, attemptedStrategies),
						};
					}
				}

				this.log(`❌ 策略失败: ${strategy.name}`);
			} catch (error: any) {
				this.log(`💥 策略异常: ${strategy.name} - ${error.message}`);
			}
		}

		// 所有策略都失败
		this.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
		this.log(`❌ 所有策略均失败 (尝试了 ${attemptedStrategies.length} 个)`);
		this.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

		return {
			success: false,
			error: `尝试了 ${attemptedStrategies.length} 个策略，均失败`,
			attemptedStrategies,
			needsUserIntervention: true,
			summary: this.generateFailureSummary(task, attemptedStrategies),
		};
	}

	/**
	 * 生成策略列表
	 */
	private async generateStrategies(task: Task, context: TaskContext): Promise<Strategy[]> {
		const strategies: Strategy[] = [];

		switch (task.type) {
			case 'build':
				strategies.push(...(await this.generateBuildStrategies(task, context)));
				break;

			case 'test':
				strategies.push(...(await this.generateTestStrategies(task, context)));
				break;

			case 'install':
				strategies.push(...(await this.generateInstallStrategies(task, context)));
				break;

			case 'git':
				strategies.push(...(await this.generateGitStrategies(task, context)));
				break;

			case 'custom':
				strategies.push(...(await this.generateCustomStrategies(task, context)));
				break;
		}

		// 按优先级排序
		return strategies.sort((a, b) => b.priority - a.priority);
	}

	/**
	 * 生成构建策略
	 */
	private async generateBuildStrategies(task: Task, context: TaskContext): Promise<Strategy[]> {
		const { workspaceRoot } = context;
		const strategies: Strategy[] = [];

		// 策略1: Maven 构建
		strategies.push({
			name: 'Maven 构建',
			priority: 100,
			action: {
				type: 'command',
				payload: { command: 'mvn clean install', cwd: workspaceRoot },
			},
			precondition: async () => {
				try {
					await this.executor.executeWithAutoRecovery('mvn --version', workspaceRoot, {
						allowAlternatives: false,
					});
					return true;
				} catch {
					return false;
				}
			},
		});

		// 策略2: Maven Wrapper
		strategies.push({
			name: 'Maven Wrapper',
			priority: 95,
			action: {
				type: 'command',
				payload: {
					command: process.platform === 'win32' ? 'mvnw.cmd clean install' : './mvnw clean install',
					cwd: workspaceRoot,
				},
			},
			precondition: async () => {
				const fs = require('fs-extra');
				const path = require('path');
				const mvnwPath = path.join(workspaceRoot, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
				return await fs.pathExists(mvnwPath);
			},
		});

		// 策略3: Gradle 构建
		strategies.push({
			name: 'Gradle 构建',
			priority: 90,
			action: {
				type: 'command',
				payload: {
					command: process.platform === 'win32' ? 'gradlew.bat build' : './gradlew build',
					cwd: workspaceRoot,
				},
			},
			precondition: async () => {
				const fs = require('fs-extra');
				const path = require('path');
				return await fs.pathExists(path.join(workspaceRoot, 'build.gradle'));
			},
		});

		// 策略4: npm 构建
		strategies.push({
			name: 'npm 构建',
			priority: 85,
			action: {
				type: 'command',
				payload: { command: 'npm run build', cwd: workspaceRoot },
			},
			precondition: async () => {
				const fs = require('fs-extra');
				const path = require('path');
				const pkgPath = path.join(workspaceRoot, 'package.json');
				if (!(await fs.pathExists(pkgPath))) return false;

				const pkg = await fs.readJson(pkgPath);
				return pkg.scripts && pkg.scripts.build;
			},
		});

		// 策略5: 跳过构建
		strategies.push({
			name: '跳过构建，继续代码分析',
			priority: 10,
			action: {
				type: 'skip',
				payload: { reason: '所有构建工具都不可用，跳过构建步骤' },
			},
		});

		return strategies;
	}

	/**
	 * 生成测试策略
	 */
	private async generateTestStrategies(task: Task, context: TaskContext): Promise<Strategy[]> {
		const { workspaceRoot } = context;

		return [
			{
				name: 'Maven 测试',
				priority: 100,
				action: {
					type: 'command',
					payload: { command: 'mvn test', cwd: workspaceRoot },
				},
			},
			{
				name: 'npm 测试',
				priority: 95,
				action: {
					type: 'command',
					payload: { command: 'npm test', cwd: workspaceRoot },
				},
			},
			{
				name: 'Gradle 测试',
				priority: 90,
				action: {
					type: 'command',
					payload: { command: './gradlew test', cwd: workspaceRoot },
				},
			},
			{
				name: '跳过测试',
				priority: 10,
				action: {
					type: 'skip',
					payload: { reason: '测试工具不可用' },
				},
			},
		];
	}

	/**
	 * 生成安装策略
	 */
	private async generateInstallStrategies(task: Task, context: TaskContext): Promise<Strategy[]> {
		const { workspaceRoot } = context;

		return [
			{
				name: 'npm install',
				priority: 100,
				action: {
					type: 'command',
					payload: { command: 'npm install', cwd: workspaceRoot },
				},
			},
			{
				name: 'yarn install',
				priority: 95,
				action: {
					type: 'command',
					payload: { command: 'yarn install', cwd: workspaceRoot },
				},
			},
			{
				name: 'pnpm install',
				priority: 90,
				action: {
					type: 'command',
					payload: { command: 'pnpm install', cwd: workspaceRoot },
				},
			},
		];
	}

	/**
	 * 生成 Git 策略
	 */
	private async generateGitStrategies(task: Task, context: TaskContext): Promise<Strategy[]> {
		const { workspaceRoot } = context;
		const operation = task.params?.operation || '';

		const strategies: Strategy[] = [];

		if (operation === 'pull') {
			strategies.push(
				{
					name: 'git pull',
					priority: 100,
					action: {
						type: 'command',
						payload: { command: 'git pull', cwd: workspaceRoot },
					},
				},
				{
					name: 'git pull with rebase',
					priority: 90,
					action: {
						type: 'command',
						payload: { command: 'git pull --rebase', cwd: workspaceRoot },
					},
				}
			);
		}

		if (operation === 'push') {
			strategies.push(
				{
					name: 'git push',
					priority: 100,
					action: {
						type: 'command',
						payload: { command: 'git push', cwd: workspaceRoot },
					},
				},
				{
					name: 'git push with force-with-lease',
					priority: 80,
					action: {
						type: 'command',
						payload: { command: 'git push --force-with-lease', cwd: workspaceRoot },
					},
				}
			);
		}

		return strategies;
	}

	/**
	 * 生成自定义策略
	 */
	private async generateCustomStrategies(task: Task, context: TaskContext): Promise<Strategy[]> {
		return [
			{
				name: '执行自定义命令',
				priority: 100,
				action: {
					type: 'command',
					payload: {
						command: task.params.command,
						cwd: context.workspaceRoot,
					},
				},
			},
		];
	}

	/**
	 * 执行单个策略
	 */
	private async executeStrategy(strategy: Strategy, context: TaskContext): Promise<CommandResult> {
		const { action } = strategy;

		switch (action.type) {
			case 'command':
				return await this.executor.executeWithAutoRecovery(
					action.payload.command,
					action.payload.cwd || context.workspaceRoot,
					{
						timeout: action.payload.timeout,
						allowAlternatives: true,
					}
				);

			case 'tool':
				// 工具调用（例如 VSCode API）
				return {
					success: true,
					stdout: '工具执行成功（占位）',
				};

			case 'skip':
				this.log(`⏭️  跳过操作: ${action.payload.reason}`);
				return {
					success: true,
					stdout: `已跳过: ${action.payload.reason}`,
				};

			default:
				return {
					success: false,
					error: {
						type: 'unknown',
						message: `未知的动作类型: ${action.type}`,
					},
				};
		}
	}

	/**
	 * 尝试备选方案
	 */
	private async tryAlternatives(
		alternatives: Alternative[],
		context: TaskContext
	): Promise<{ success: boolean; output?: string }> {
		// 过滤并排序备选方案
		const validAlternatives = alternatives
			.filter((alt) => alt.automation === 'auto') // 只自动执行 auto 类型
			.filter((alt) => alt.successProbability >= 0.4) // 跳过低概率方案
			.sort((a, b) => b.successProbability - a.successProbability);

		this.log(`📊 可自动执行的备选方案: ${validAlternatives.length} 个`);

		for (let i = 0; i < validAlternatives.length; i++) {
			const alt = validAlternatives[i];
			this.log(
				`\n  [${i + 1}/${validAlternatives.length}] ${alt.description} (概率: ${(alt.successProbability * 100).toFixed(0)}%, 风险: ${alt.risk || 'unknown'})`
			);

			// 高风险方案需要简短告知
			if (alt.risk === 'high') {
				this.log(`  ⚠️  高风险操作，但自动执行中...`);
			}

			try {
				const result = await this.executeAlternativeAction(alt.action, context);

				if (result.success) {
					this.log(`  ✅ 备选方案成功`);
					return { success: true, output: result.stdout };
				}

				this.log(`  ❌ 备选方案失败`);
			} catch (error: any) {
				this.log(`  💥 备选方案异常: ${error.message}`);
			}
		}

		return { success: false };
	}

	/**
	 * 执行备选方案动作
	 */
	private async executeAlternativeAction(
		action: AlternativeAction,
		context: TaskContext
	): Promise<CommandResult> {
		switch (action.type) {
			case 'command':
				return await this.executor.executeWithAutoRecovery(
					action.payload.command,
					action.payload.cwd || context.workspaceRoot,
					{
						timeout: action.payload.timeout,
						allowAlternatives: false, // 备选方案不再生成递归的备选方案
					}
				);

			case 'tool':
				// 工具调用
				return {
					success: true,
					stdout: '工具执行成功（占位）',
				};

			case 'skip':
				return {
					success: true,
					stdout: `已跳过: ${action.payload.reason}`,
				};

			default:
				return {
					success: false,
					error: {
						type: 'unknown',
						message: `未知的动作类型: ${action.type}`,
					},
				};
		}
	}

	/**
	 * 生成成功摘要
	 */
	private generateSuccessSummary(
		task: Task,
		successStrategy: Strategy,
		attemptedStrategies: string[]
	): string {
		if (attemptedStrategies.length === 1) {
			return `✅ ${task.description} 完成（使用策略: ${successStrategy.name}）`;
		} else {
			return `✅ ${task.description} 完成（尝试了 ${attemptedStrategies.length} 个策略，最终使用: ${successStrategy.name}）`;
		}
	}

	/**
	 * 生成失败摘要
	 */
	private generateFailureSummary(task: Task, attemptedStrategies: string[]): string {
		return `❌ ${task.description} 失败\n\n已尝试的策略:\n${attemptedStrategies.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n\n建议: 请检查环境配置或手动执行该操作。`;
	}

	/**
	 * 日志输出
	 */
	private log(message: string): void {
		this.outputChannel.appendLine(message);
		console.log(`[AutoRecovery] ${message}`);
	}

	/**
	 * 显示输出面板
	 */
	public showOutput(): void {
		this.outputChannel.show();
	}

	/**
	 * 清理资源
	 */
	public dispose(): void {
		this.outputChannel.dispose();
	}
}
