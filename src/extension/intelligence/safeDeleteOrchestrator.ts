/**
 * 安全删除编排器
 *
 * 整合多层引用发现和事务性删除，确保删除操作的完整性和安全性
 */

import * as vscode from 'vscode';
import { MultiLayerReferenceDiscovery, Reference, DeletionPlan, ReferenceType } from './referenceDiscovery';

export interface DeleteOperation {
	/** 文件路径 */
	file: string;
	/** 删除操作类型 */
	type: 'delete_file' | 'delete_lines' | 'replace_content';
	/** 要删除的行范围（1-based，闭区间） */
	lines?: { start: number; end: number };
	/** 替换内容（用于删除 import 等） */
	replacement?: string;
	/** 操作描述 */
	description: string;
}

export interface DeleteResult {
	success: boolean;
	appliedOperations: DeleteOperation[];
	failedOperations: DeleteOperation[];
	error?: Error;
}

export class SafeDeleteOrchestrator {
	constructor(
		private discovery: MultiLayerReferenceDiscovery,
		private workspaceRoot: string
	) {}

	/**
	 * 安全删除接口及其所有引用
	 *
	 * @param symbolName 要删除的符号名称（如 MessageSendVO）
	 * @param options 删除选项
	 */
	async deleteInterfaceWithReferences(
		symbolName: string,
		options: {
			/** 是否需要用户确认 */
			requireConfirmation?: boolean;
			/** 是否包含 Git 历史搜索 */
			includeGitHistory?: boolean;
			/** 文件类型模式 */
			filePattern?: string;
			/** 是否自动保存修改的文件 */
			autoSave?: boolean;
		} = {}
	): Promise<DeleteResult> {
		const {
			requireConfirmation = true,
			includeGitHistory = false,
			filePattern = '*.java',
			autoSave = true,
		} = options;

		try {
			// 第1步：构建删除计划
			console.log(`🔍 分析 ${symbolName} 的引用关系...`);
			const plan = await this.discovery.buildDeletionPlan(symbolName);

			if (plan.references.length === 0) {
				vscode.window.showWarningMessage(
					`未找到 ${symbolName} 的任何引用。可能已被删除或从未创建。`
				);
				return {
					success: true,
					appliedOperations: [],
					failedOperations: [],
				};
			}

			// 第2步：生成删除操作
			const operations = await this.generateDeleteOperations(symbolName, plan);

			// 第3步：向用户展示删除计划
			this.displayDeletionPlan(symbolName, plan, operations);

			// 第4步：请求用户确认
			if (requireConfirmation) {
				const confirmed = await this.requestUserConfirmation(symbolName, plan);
				if (!confirmed) {
					vscode.window.showInformationMessage('删除操作已取消');
					return {
						success: false,
						appliedOperations: [],
						failedOperations: [],
					};
				}
			}

			// 第5步：执行事务性删除
			console.log(`🗑️  执行删除操作...`);
			const result = await this.executeTransactionalDelete(operations, autoSave);

			// 第6步：显示结果
			if (result.success) {
				vscode.window.showInformationMessage(
					`✅ 成功删除 ${symbolName} 及其 ${plan.references.length} 处引用`
				);
			} else {
				vscode.window.showErrorMessage(
					`❌ 删除失败：${result.error?.message}。已回滚所有更改。`
				);
			}

			return result;
		} catch (error) {
			console.error('[SafeDelete] 删除失败:', error);
			return {
				success: false,
				appliedOperations: [],
				failedOperations: [],
				error: error as Error,
			};
		}
	}

	/**
	 * 生成删除操作列表
	 */
	private async generateDeleteOperations(
		symbolName: string,
		plan: DeletionPlan
	): Promise<DeleteOperation[]> {
		const operations: DeleteOperation[] = [];
		const fileGroups = this.groupReferencesByFile(plan.references);

		for (const [file, refs] of fileGroups.entries()) {
			// 判断是否需要删除整个文件
			if (this.shouldDeleteEntireFile(file, refs, symbolName)) {
				operations.push({
					file,
					type: 'delete_file',
					description: `删除文件 ${file}（包含 ${symbolName} 的定义）`,
				});
			} else {
				// 删除特定的引用行
				for (const ref of refs) {
					operations.push({
						file: ref.file,
						type: this.getOperationType(ref),
						lines: { start: ref.line, end: ref.line },
						description: this.getOperationDescription(ref, symbolName),
					});
				}
			}
		}

		return operations;
	}

	/**
	 * 判断是否应该删除整个文件
	 */
	private shouldDeleteEntireFile(file: string, refs: Reference[], symbolName: string): boolean {
		// 如果文件名与符号名匹配，且是定义文件，则删除整个文件
		const fileName = file.split('/').pop()?.replace(/\.\w+$/, '');
		if (fileName === symbolName) {
			// 检查是否包含类定义
			const hasClassDef = refs.some(
				(r) => r.context.includes(`class ${symbolName}`) || r.context.includes(`interface ${symbolName}`)
			);
			return hasClassDef;
		}
		return false;
	}

	private getOperationType(ref: Reference): DeleteOperation['type'] {
		if (ref.type === ReferenceType.Import) {
			return 'delete_lines';
		}
		return 'delete_lines';
	}

	private getOperationDescription(ref: Reference, symbolName: string): string {
		const typeDesc = {
			import: 'import 语句',
			type: '类型注解',
			variable: '变量声明',
			method_call: '方法调用',
			inheritance: '继承/实现',
			instantiation: '实例化',
			unknown: '引用',
		}[ref.type];

		return `删除 ${ref.file}:${ref.line} 的 ${typeDesc}`;
	}

	/**
	 * 按文件分组引用
	 */
	private groupReferencesByFile(refs: Reference[]): Map<string, Reference[]> {
		const groups = new Map<string, Reference[]>();
		for (const ref of refs) {
			if (!groups.has(ref.file)) {
				groups.set(ref.file, []);
			}
			groups.get(ref.file)!.push(ref);
		}
		return groups;
	}

	/**
	 * 在输出通道显示删除计划
	 */
	private displayDeletionPlan(
		symbolName: string,
		plan: DeletionPlan,
		operations: DeleteOperation[]
	): void {
		const output = vscode.window.createOutputChannel(`删除计划: ${symbolName}`);
		output.clear();
		output.appendLine(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
		output.appendLine(`📋 删除计划: ${symbolName}`);
		output.appendLine(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
		output.appendLine(``);

		// 影响范围
		output.appendLine(`📊 影响范围:`);
		output.appendLine(`   - 文件数: ${plan.impact.fileCount}`);
		output.appendLine(`   - 引用数: ${plan.impact.lineCount}`);
		output.appendLine(`   - 风险等级: ${this.getRiskEmoji(plan.impact.risk)} ${plan.impact.risk.toUpperCase()}`);
		output.appendLine(``);

		// 操作列表
		output.appendLine(`🗑️  删除操作 (${operations.length} 项):`);
		output.appendLine(``);

		const fileGroups = new Map<string, DeleteOperation[]>();
		for (const op of operations) {
			if (!fileGroups.has(op.file)) {
				fileGroups.set(op.file, []);
			}
			fileGroups.get(op.file)!.push(op);
		}

		for (const [file, ops] of fileGroups.entries()) {
			output.appendLine(`📄 ${file}`);
			for (const op of ops) {
				const icon = op.type === 'delete_file' ? '🗑️ ' : '✂️ ';
				output.appendLine(`   ${icon} ${op.description}`);
			}
			output.appendLine(``);
		}

		// 引用详情
		output.appendLine(`🔍 引用详情:`);
		output.appendLine(``);

		const refsBySource = this.groupReferencesBySource(plan.references);
		for (const [source, refs] of refsBySource.entries()) {
			output.appendLine(`   [${source.toUpperCase()}] ${refs.length} 个引用`);
		}
		output.appendLine(``);

		// 引用列表
		for (const ref of plan.references) {
			const typeLabel = ref.type.padEnd(15);
			output.appendLine(`   ${ref.file}:${ref.line} | ${typeLabel} | ${ref.context}`);
		}

		output.appendLine(``);
		output.appendLine(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
		output.show(true);
	}

	private getRiskEmoji(risk: string): string {
		return { low: '🟢', medium: '🟡', high: '🔴' }[risk] || '⚪';
	}

	private groupReferencesBySource(refs: Reference[]): Map<string, Reference[]> {
		const groups = new Map<string, Reference[]>();
		for (const ref of refs) {
			if (!groups.has(ref.source)) {
				groups.set(ref.source, []);
			}
			groups.get(ref.source)!.push(ref);
		}
		return groups;
	}

	/**
	 * 请求用户确认
	 */
	private async requestUserConfirmation(symbolName: string, plan: DeletionPlan): Promise<boolean> {
		const message = `确认删除 ${symbolName} 及其 ${plan.references.length} 处引用？（影响 ${plan.impact.fileCount} 个文件，风险: ${plan.impact.risk.toUpperCase()}）`;

		const action = await vscode.window.showWarningMessage(
			message,
			{ modal: true },
			'确认删除',
			'查看详情',
			'取消'
		);

		if (action === '查看详情') {
			// 已在 displayDeletionPlan 中显示
			return this.requestUserConfirmation(symbolName, plan); // 递归再次确认
		}

		return action === '确认删除';
	}

	/**
	 * 执行事务性删除（全部成功或全部回滚）
	 */
	private async executeTransactionalDelete(
		operations: DeleteOperation[],
		autoSave: boolean
	): Promise<DeleteResult> {
		const appliedOperations: DeleteOperation[] = [];
		const backups = new Map<string, string>(); // 文件备份
		let workspaceEdit: vscode.WorkspaceEdit | null = null;

		try {
			// 准备 WorkspaceEdit
			workspaceEdit = new vscode.WorkspaceEdit();

			// 备份所有涉及的文件
			const affectedFiles = new Set(operations.map((op) => op.file));
			for (const file of affectedFiles) {
				const uri = vscode.Uri.file(`${this.workspaceRoot}/${file}`);
				try {
					const document = await vscode.workspace.openTextDocument(uri);
					backups.set(file, document.getText());
				} catch (error) {
					console.warn(`无法备份文件 ${file}:`, error);
				}
			}

			// 执行删除操作
			for (const op of operations) {
				const uri = vscode.Uri.file(`${this.workspaceRoot}/${op.file}`);

				if (op.type === 'delete_file') {
					workspaceEdit.deleteFile(uri);
				} else if (op.type === 'delete_lines' && op.lines) {
					const document = await vscode.workspace.openTextDocument(uri);
					const startLine = op.lines.start - 1; // 转为 0-based
					const endLine = op.lines.end; // end 行的下一行

					const range = new vscode.Range(
						new vscode.Position(startLine, 0),
						new vscode.Position(endLine, 0)
					);

					workspaceEdit.delete(uri, range);
				}

				appliedOperations.push(op);
			}

			// 应用所有编辑
			const success = await vscode.workspace.applyEdit(workspaceEdit);

			if (!success) {
				throw new Error('WorkspaceEdit 应用失败');
			}

			// 保存所有修改的文件
			if (autoSave) {
				for (const file of affectedFiles) {
					const uri = vscode.Uri.file(`${this.workspaceRoot}/${file}`);
					const document = vscode.workspace.textDocuments.find(
						(doc) => doc.uri.toString() === uri.toString()
					);
					if (document && document.isDirty) {
						await document.save();
					}
				}
			}

			return {
				success: true,
				appliedOperations,
				failedOperations: [],
			};
		} catch (error) {
			console.error('[SafeDelete] 删除失败，正在回滚...', error);

			// 回滚：恢复所有备份
			await this.rollbackChanges(backups);

			return {
				success: false,
				appliedOperations: [],
				failedOperations: appliedOperations,
				error: error as Error,
			};
		}
	}

	/**
	 * 回滚更改
	 */
	private async rollbackChanges(backups: Map<string, string>): Promise<void> {
		for (const [file, content] of backups.entries()) {
			try {
				const uri = vscode.Uri.file(`${this.workspaceRoot}/${file}`);
				const document = await vscode.workspace.openTextDocument(uri);

				const edit = new vscode.WorkspaceEdit();
				const fullRange = new vscode.Range(
					document.positionAt(0),
					document.positionAt(document.getText().length)
				);
				edit.replace(uri, fullRange, content);

				await vscode.workspace.applyEdit(edit);
				await document.save();

				console.log(`✅ 已回滚 ${file}`);
			} catch (error) {
				console.error(`❌ 回滚失败 ${file}:`, error);
			}
		}
	}
}
