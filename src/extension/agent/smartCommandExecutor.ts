/**
 * 智能命令执行器 - 自动错误恢复
 *
 * 在命令失败时自动生成并建议备选方案，
 * 让 LLM 能够自主决策并最小化人工干预
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { exec } from 'child_process';
import { promisify } from 'util';
import { executeCommand } from './runCommandTool';

const execAsync = promisify(exec);

// ==================== 类型定义 ====================

export interface CommandResult {
	/** 操作是否成功 */
	success: boolean;
	/** 标准输出 */
	stdout?: string;
	/** 标准错误 */
	stderr?: string;
	/** 退出码 */
	exitCode?: number;
	/** 错误信息 */
	error?: {
		type: ErrorType;
		message: string;
		details?: any;
		/** 🔑 自动化的备选方案 */
		alternatives?: Alternative[];
	};
	/** 执行上下文 */
	context?: {
		command: string;
		cwd: string;
		duration: number;
		attempt?: number;
	};
}

export type ErrorType =
	| 'validation'
	| 'not_found'
	| 'execution'
	| 'timeout'
	| 'permission'
	| 'buffer_overflow'
	| 'max_attempts_reached'
	| 'unknown';

export interface Alternative {
	/** 备选方案描述 */
	description: string;
	/** 自动化程度 */
	automation: 'auto' | 'semi-auto' | 'manual';
	/** 具体的替代操作 */
	action: AlternativeAction;
	/** 预期成功率（0-1） */
	successProbability: number;
	/** 副作用风险等级 */
	risk?: 'low' | 'medium' | 'high';
}

export interface AlternativeAction {
	type: 'command' | 'tool' | 'skip';
	payload: any;
}

export interface ExecuteOptions {
	/** 超时时间（毫秒） */
	timeout?: number;
	/** 最大尝试次数 */
	maxAttempts?: number;
	/** 是否允许生成备选方案 */
	allowAlternatives?: boolean;
	/** 最大输出缓冲区（字节） */
	maxBuffer?: number;
	/** 环境变量 */
	env?: Record<string, string>;
}

// ==================== 主类 ====================

export class SmartCommandExecutor {
	private attemptHistory: Map<string, number> = new Map();
	private commandCache: Map<string, boolean> = new Map();

	constructor(private outputChannel?: vscode.OutputChannel) {}

	/**
	 * 执行命令（带自动恢复）
	 */
	async executeWithAutoRecovery(
		command: string,
		cwd: string,
		options: ExecuteOptions = {}
	): Promise<CommandResult> {
		const {
			maxAttempts = 3,
			allowAlternatives = true,
			timeout = 120000,
			maxBuffer = 10 * 1024 * 1024,
			env = process.env,
		} = options;

		// 参数验证
		const validation = this.validateInput(command, cwd);
		if (!validation.valid) {
			return {
				success: false,
				error: {
					type: 'validation',
					message: validation.error!,
					alternatives: [],
				},
			};
		}

		// 检查尝试次数
		const commandKey = `${command}@${cwd}`;
		const attempts = this.attemptHistory.get(commandKey) || 0;

		if (attempts >= maxAttempts) {
			this.log(`[SmartExecutor] 达到最大尝试次数 (${attempts}/${maxAttempts})`);
			return {
				success: false,
				error: {
					type: 'max_attempts_reached',
					message: `已尝试 ${attempts} 次，仍然失败`,
					alternatives: allowAlternatives
						? await this.getFallbackStrategies(command, cwd)
						: [],
				},
			};
		}

		// 执行命令
		this.log(`[SmartExecutor] 执行命令 (尝试 ${attempts + 1}/${maxAttempts}): ${command}`);
		const startTime = Date.now();
		this.attemptHistory.set(commandKey, attempts + 1);

		try {
			// 使用带进度检查的 executeCommand
			const abortController = new AbortController();
			const resultText = await executeCommand(
				command,
				cwd,
				abortController.signal,
				timeout,
				maxBuffer,
			);

			const duration = Date.now() - startTime;
			// 解析 executeCommand 的结果格式
			const statusMatch = resultText.match(/Status: (exited|timed_out)\nExit code: (.+)\n/);
			const status = statusMatch?.[1];
			const stdoutMatch = resultText.match(/stdout:\n([\s\S]*?)\nstderr:/);
			const stderrMatch = resultText.match(/stderr:\n([\s\S]*?)(?:\n(?:Output truncated|Progress checks:|$))/);
			const exitCode = statusMatch?.[2] === 'none' ? undefined : Number(statusMatch?.[2]);

			if (status === 'timed_out' || (exitCode !== undefined && exitCode !== 0)) {
				this.log(`[SmartExecutor] ✗ 命令失败 (耗时 ${duration}ms)`);
				const result: CommandResult = {
					success: false,
					stdout: stdoutMatch?.[1] ?? '',
					stderr: stderrMatch?.[1] ?? '',
					exitCode,
					error: {
						type: status === 'timed_out' ? 'timeout' : 'execution',
						message: status === 'timed_out' ? `命令执行超时 (>${duration}ms)` : `命令执行失败 (exit code ${exitCode})`,
					},
					context: { command, cwd, duration, attempt: attempts + 1 },
				};
				if (allowAlternatives && result.error) {
					result.error.alternatives = await this.generateAlternatives(command, cwd, result);
				}
				return result;
			}

			this.log(`[SmartExecutor] ✓ 命令成功 (耗时 ${duration}ms)`);

			// 成功后重置计数
			this.attemptHistory.delete(commandKey);

			return {
				success: true,
				stdout: stdoutMatch?.[1] ?? '',
				stderr: stderrMatch?.[1] ?? '',
				exitCode: exitCode ?? 0,
				context: {
					command,
					cwd,
					duration,
					attempt: attempts + 1,
				},
			};
		} catch (error: any) {
			const duration = Date.now() - startTime;
			this.log(`[SmartExecutor] ✗ 命令失败 (耗时 ${duration}ms)`);

			// 分类错误并生成备选方案
			const result = await this.categorizeError(error, command, cwd, duration);

			if (allowAlternatives && result.error) {
				result.error.alternatives = await this.generateAlternatives(command, cwd, result);
			}

			result.context = {
				command,
				cwd,
				duration,
				attempt: attempts + 1,
			};

			return result;
		}
	}

	/**
	 * 参数验证
	 */
	private validateInput(command: string, cwd: string): { valid: boolean; error?: string } {
		if (!command || !command.trim()) {
			return { valid: false, error: '命令不能为空' };
		}

		if (!cwd) {
			return { valid: false, error: '工作目录不能为空' };
		}

		if (!fs.pathExistsSync(cwd)) {
			return { valid: false, error: `工作目录不存在: ${cwd}` };
		}

		return { valid: true };
	}

	/**
	 * 错误分类
	 */
	private async categorizeError(
		error: any,
		command: string,
		cwd: string,
		duration: number
	): Promise<CommandResult> {
		// 命令执行失败（exit code != 0）
		if (error.code && typeof error.code === 'number') {
			return {
				success: false,
				stdout: error.stdout || '',
				stderr: error.stderr || '',
				exitCode: error.code,
				error: {
					type: 'execution',
					message: `命令执行失败 (exit code ${error.code})`,
					details: {
						stdout: error.stdout,
						stderr: error.stderr,
					},
				},
			};
		}

		// 超时
		if (error.killed && error.signal === 'SIGTERM') {
			return {
				success: false,
				error: {
					type: 'timeout',
					message: `命令执行超时 (>${duration}ms)`,
				},
			};
		}

		// 输出超过 maxBuffer
		if (error.message?.includes('maxBuffer') || error.message?.includes('stdout maxBuffer')) {
			return {
				success: false,
				stdout: error.stdout?.substring(0, 10000) || '',
				stderr: error.stderr?.substring(0, 10000) || '',
				error: {
					type: 'buffer_overflow',
					message: '命令输出超过缓冲区限制',
					details: {
						partialOutput: error.stdout?.substring(0, 1000),
					},
				},
			};
		}

		// 权限错误
		if (error.code === 'EACCES' || error.message?.includes('permission denied')) {
			return {
				success: false,
				error: {
					type: 'permission',
					message: '权限不足',
					details: { originalError: error.message },
				},
			};
		}

		// 命令不存在
		if (error.code === 'ENOENT' || error.message?.includes('not found') || error.stderr?.includes('not found')) {
			return {
				success: false,
				error: {
					type: 'not_found',
					message: '命令或程序未找到',
					details: { command: command.split(' ')[0] },
				},
			};
		}

		// 未知错误（兜底）
		return {
			success: false,
			error: {
				type: 'unknown',
				message: error.message || '命令执行失败',
				details: {
					errorCode: error.code,
					errorMessage: error.message,
				},
			},
		};
	}

	/**
	 * 生成备选方案
	 */
	private async generateAlternatives(
		command: string,
		cwd: string,
		failedResult: CommandResult
	): Promise<Alternative[]> {
		const alternatives: Alternative[] = [];
		const errorType = failedResult.error?.type;

		this.log(`[SmartExecutor] 生成备选方案 (错误类型: ${errorType})`);

		switch (errorType) {
			case 'not_found':
				alternatives.push(...(await this.handleCommandNotFound(command, cwd)));
				break;

			case 'execution':
				alternatives.push(...(await this.handleExecutionFailure(command, cwd, failedResult)));
				break;

			case 'timeout':
				alternatives.push(...(await this.handleTimeout(command, cwd)));
				break;

			case 'permission':
				alternatives.push(...(await this.handlePermission(command, cwd)));
				break;

			case 'buffer_overflow':
				alternatives.push(...(await this.handleBufferOverflow(command, cwd)));
				break;

			case 'max_attempts_reached':
				alternatives.push(...(await this.getFallbackStrategies(command, cwd)));
				break;
		}

		// 按成功率排序
		return alternatives.sort((a, b) => b.successProbability - a.successProbability);
	}

	/**
	 * 处理命令不存在
	 */
	private async handleCommandNotFound(command: string, cwd: string): Promise<Alternative[]> {
		const alternatives: Alternative[] = [];
		const cmdName = command.split(' ')[0];

		this.log(`[SmartExecutor] 处理命令不存在: ${cmdName}`);

		// ========== Git 特殊处理 ==========
		if (cmdName === 'git') {
			alternatives.push({
				description: '使用 VSCode 内置 Git API',
				automation: 'auto',
				action: {
					type: 'tool',
					payload: {
						tool: 'vscodeGitAPI',
						operation: this.parseGitCommand(command),
					},
				},
				successProbability: 0.9,
				risk: 'low',
			});
		}

		// ========== Node/npm 特殊处理 ==========
		if (['npm', 'yarn', 'pnpm'].includes(cmdName)) {
			const altPkgManagers = ['npm', 'yarn', 'pnpm'].filter((pm) => pm !== cmdName);

			for (const pm of altPkgManagers) {
				if (await this.commandExists(pm)) {
					alternatives.push({
						description: `使用 ${pm} 替代 ${cmdName}`,
						automation: 'auto',
						action: {
							type: 'command',
							payload: {
								command: command.replace(cmdName, pm),
								cwd,
							},
						},
						successProbability: 0.85,
						risk: 'low',
					});
				}
			}
		}

		// ========== Python 特殊处理 ==========
		if (cmdName === 'python' || cmdName === 'python3') {
			const altPythonCmd = cmdName === 'python' ? 'python3' : 'python';
			if (await this.commandExists(altPythonCmd)) {
				alternatives.push({
					description: `使用 ${altPythonCmd} 替代 ${cmdName}`,
					automation: 'auto',
					action: {
						type: 'command',
						payload: {
							command: command.replace(cmdName, altPythonCmd),
							cwd,
						},
					},
					successProbability: 0.9,
					risk: 'low',
				});
			}
		}

		// ========== 通用兜底：跳过 ==========
		alternatives.push({
			description: `跳过 ${cmdName} 操作，继续后续任务`,
			automation: 'auto',
			action: {
				type: 'skip',
				payload: { reason: `${cmdName} 不可用` },
			},
			successProbability: 0.3,
			risk: 'low',
		});

		return alternatives;
	}

	/**
	 * 处理执行失败
	 */
	private async handleExecutionFailure(
		command: string,
		cwd: string,
		failedResult: CommandResult
	): Promise<Alternative[]> {
		const alternatives: Alternative[] = [];
		const stderr = failedResult.stderr || '';
		const stdout = failedResult.stdout || '';

		this.log(`[SmartExecutor] 处理执行失败，分析错误信息...`);

		// ========== Maven 依赖问题 ==========
		if (stderr.includes('Could not find artifact') || stderr.includes('Failed to collect dependencies')) {
			alternatives.push({
				description: '跳过测试加速构建',
				automation: 'auto',
				action: {
					type: 'command',
					payload: {
						command: `${command} -DskipTests`,
						cwd,
					},
				},
				successProbability: 0.7,
				risk: 'low',
			});

			alternatives.push({
				description: '使用 -U 强制更新依赖',
				automation: 'auto',
				action: {
					type: 'command',
					payload: {
						command: `${command} -U`,
						cwd,
					},
				},
				successProbability: 0.6,
				risk: 'low',
			});

			alternatives.push({
				description: '清理 Maven 本地仓库缓存',
				automation: 'auto',
				action: {
					type: 'command',
					payload: {
						command: command.includes('mvnw')
							? './mvnw dependency:purge-local-repository'
							: 'mvn dependency:purge-local-repository',
						cwd,
					},
				},
				successProbability: 0.5,
				risk: 'medium',
			});
		}

		// ========== Maven 编译错误 ==========
		if (
			stderr.includes('compilation error') ||
			stderr.includes('COMPILATION ERROR') ||
			(failedResult.exitCode === 1 && command.includes('compile'))
		) {
			alternatives.push({
				description: '仅清理，不构建',
				automation: 'auto',
				action: {
					type: 'command',
					payload: {
						command: command.replace(/install|package|compile/, 'clean'),
						cwd,
					},
				},
				successProbability: 0.9,
				risk: 'low',
			});

			alternatives.push({
				description: '跳过编译，直接分析代码',
				automation: 'auto',
				action: {
					type: 'skip',
					payload: {
						reason: '编译失败，但可以继续分析源代码',
					},
				},
				successProbability: 0.6,
				risk: 'low',
			});
		}

		// ========== npm/yarn 依赖问题 ==========
		if (stderr.includes('ERESOLVE') || stderr.includes('peer dep')) {
			alternatives.push({
				description: '使用 --legacy-peer-deps 强制安装',
				automation: 'auto',
				action: {
					type: 'command',
					payload: {
						command: `${command} --legacy-peer-deps`,
						cwd,
					},
				},
				successProbability: 0.8,
				risk: 'medium',
			});

			alternatives.push({
				description: '使用 --force 强制安装',
				automation: 'auto',
				action: {
					type: 'command',
					payload: {
						command: `${command} --force`,
						cwd,
					},
				},
				successProbability: 0.7,
				risk: 'high',
			});
		}

		// ========== Git 冲突 ==========
		if (stderr.includes('conflict') || stderr.includes('CONFLICT')) {
			alternatives.push({
				description: 'Stash 当前更改后重试',
				automation: 'auto',
				action: {
					type: 'command',
					payload: {
						command: 'git stash && ' + command,
						cwd,
					},
				},
				successProbability: 0.8,
				risk: 'medium',
			});
		}

		return alternatives;
	}

	/**
	 * 处理超时
	 */
	private async handleTimeout(command: string, cwd: string): Promise<Alternative[]> {
		return [
			{
				description: '增加超时时间到 10 分钟',
				automation: 'auto',
				action: {
					type: 'command',
					payload: {
						command,
						cwd,
						timeout: 600000,
					},
				},
				successProbability: 0.75,
				risk: 'low',
			},
			{
				description: '后台执行并定期检查状态',
				automation: 'semi-auto',
				action: {
					type: 'command',
					payload: {
						command,
						cwd,
						background: true,
					},
				},
				successProbability: 0.85,
				risk: 'low',
			},
			{
				description: '简化命令（如跳过测试）',
				automation: 'auto',
				action: {
					type: 'command',
					payload: {
						command: `${command} -DskipTests`,
						cwd,
					},
				},
				successProbability: 0.7,
				risk: 'low',
			},
		];
	}

	/**
	 * 处理权限问题
	 */
	private async handlePermission(command: string, cwd: string): Promise<Alternative[]> {
		const alternatives: Alternative[] = [];

		// Unix 系统：尝试修改权限
		if (process.platform !== 'win32') {
			const cmdName = command.split(' ')[0];
			const cmdPath = path.join(cwd, cmdName);

			if (await fs.pathExists(cmdPath)) {
				alternatives.push({
					description: '修改文件为可执行后重试',
					automation: 'auto',
					action: {
						type: 'command',
						payload: {
							command: `chmod +x ${cmdName} && ${command}`,
							cwd,
						},
					},
					successProbability: 0.7,
					risk: 'low',
				});
			}
		}

		// 移除 sudo
		if (command.startsWith('sudo ')) {
			alternatives.push({
				description: '不使用 sudo，尝试当前用户权限',
				automation: 'auto',
				action: {
					type: 'command',
					payload: {
						command: command.replace(/^sudo\s+/, ''),
						cwd,
					},
				},
				successProbability: 0.5,
				risk: 'low',
			});
		}

		return alternatives;
	}

	/**
	 * 处理输出溢出
	 */
	private async handleBufferOverflow(command: string, cwd: string): Promise<Alternative[]> {
		const tempFile = `/tmp/output_${Date.now()}.txt`;

		return [
			{
				description: '重定向输出到临时文件',
				automation: 'auto',
				action: {
					type: 'command',
					payload: {
						command: `${command} > ${tempFile} 2>&1 && echo "输出已保存到 ${tempFile}"`,
						cwd,
					},
				},
				successProbability: 0.95,
				risk: 'low',
			},
			{
				description: '仅显示最后 100 行',
				automation: 'auto',
				action: {
					type: 'command',
					payload: {
						command: `${command} 2>&1 | tail -100`,
						cwd,
					},
				},
				successProbability: 0.85,
				risk: 'low',
			},
			{
				description: '使用 head 仅显示前 100 行',
				automation: 'auto',
				action: {
					type: 'command',
					payload: {
						command: `${command} 2>&1 | head -100`,
						cwd,
					},
				},
				successProbability: 0.8,
				risk: 'low',
			},
		];
	}

	/**
	 * 获取兜底策略（所有尝试都失败后）
	 */
	private async getFallbackStrategies(command: string, cwd: string): Promise<Alternative[]> {
		return [
			{
				description: '跳过当前操作，继续后续任务',
				automation: 'auto',
				action: {
					type: 'skip',
					payload: {
						reason: `命令 "${command}" 执行失败，跳过此步骤`,
					},
				},
				successProbability: 0.4,
				risk: 'low',
			},
			{
				description: '请求用户手动执行此命令',
				automation: 'manual',
				action: {
					type: 'tool',
					payload: {
						tool: 'askUser',
						message: `自动执行 "${command}" 失败，是否需要手动执行？`,
					},
				},
				successProbability: 0.2,
				risk: 'low',
			},
		];
	}

	// ==================== 辅助方法 ====================

	/**
	 * 检查命令是否存在
	 */
	private async commandExists(cmd: string): Promise<boolean> {
		if (this.commandCache.has(cmd)) {
			return this.commandCache.get(cmd)!;
		}

		try {
			const checkCmd = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
			await execAsync(checkCmd);
			this.commandCache.set(cmd, true);
			return true;
		} catch {
			this.commandCache.set(cmd, false);
			return false;
		}
	}

	/**
	 * 解析 Git 命令
	 */
	private parseGitCommand(command: string): any {
		const parts = command.split(' ').slice(1); // 移除 'git'
		const operation = parts[0];

		return {
			operation,
			args: parts.slice(1),
		};
	}

	/**
	 * 日志输出
	 */
	private log(message: string): void {
		if (this.outputChannel) {
			this.outputChannel.appendLine(message);
		}
		console.log(message);
	}

	/**
	 * 清理历史记录
	 */
	public clearHistory(): void {
		this.attemptHistory.clear();
		this.commandCache.clear();
	}
}
