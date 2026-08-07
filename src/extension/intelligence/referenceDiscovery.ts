/**
 * 多层防御的引用发现系统
 *
 * 在极端环境下保证识别所有代码引用的4层策略：
 * 1. SQLite FTS5 索引（快速，适用于正常情况）
 * 2. Tree-sitter AST 分析（精确，适用于索引失效）
 * 3. Ripgrep 文本扫描（兜底，适用于 AST 失败）
 * 4. Git 历史回溯（终极，适用于文件已删除）
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ==================== 类型定义 ====================

export interface Reference {
	/** 文件路径（相对于工作区根目录） */
	file: string;
	/** 行号（1-based） */
	line: number;
	/** 列号（1-based，可选） */
	column?: number;
	/** 引用类型 */
	type: ReferenceType;
	/** 上下文代码片段 */
	context: string;
	/** 来源层级 */
	source: 'index' | 'ast' | 'text' | 'git';
}

export enum ReferenceType {
	Import = 'import',
	TypeAnnotation = 'type',
	VariableDeclaration = 'variable',
	MethodCall = 'method_call',
	Inheritance = 'inheritance',
	Instantiation = 'instantiation',
	Unknown = 'unknown',
}

export interface DeletionPlan {
	/** 要删除的引用列表 */
	references: Reference[];
	/** 依赖分析结果 */
	dependencies: DependencyInfo[];
	/** 估计影响范围 */
	impact: ImpactEstimate;
}

export interface DependencyInfo {
	/** 符号名称 */
	symbol: string;
	/** 依赖类型 */
	relation: 'uses' | 'extends' | 'implements' | 'contains';
	/** 依赖的符号 */
	dependsOn: string[];
}

export interface ImpactEstimate {
	/** 影响的文件数 */
	fileCount: number;
	/** 影响的行数 */
	lineCount: number;
	/** 风险等级 */
	risk: 'low' | 'medium' | 'high';
}

// ==================== 第1层：智能索引 ====================

export class Layer1_IndexSearch {
	constructor(
		private workspaceRoot: string,
		private indexClient: any // SQLiteIndexWorkerClient 实例
	) {}

	async findReferences(symbol: string): Promise<Reference[]> {
		try {
			// 检查索引新鲜度
			const indexAge = await this.getIndexAge();
			if (indexAge > 5 * 60 * 1000) {
				console.warn('[Layer1] 索引可能过期（距今 ${indexAge / 1000}s），建议增量更新');
			}

			// 查询 FTS5 索引
			const results = await this.indexClient.search(symbol);

			if (!results || results.length === 0) {
				return [];
			}

			// 转换为统一格式
			return results.map((r: any) => ({
				file: r.file_path,
				line: r.line,
				column: r.column,
				type: this.inferTypeFromContext(r.context),
				context: r.context,
				source: 'index' as const,
			}));
		} catch (error) {
			console.error('[Layer1] 索引查询失败:', error);
			return [];
		}
	}

	private async getIndexAge(): Promise<number> {
		// 从 index_meta 表获取最后更新时间
		try {
			const meta = await this.indexClient.getMeta('last_index_time');
			return Date.now() - parseInt(meta);
		} catch {
			return Infinity;
		}
	}

	private inferTypeFromContext(context: string): ReferenceType {
		if (/^import\s+/.test(context.trim())) return ReferenceType.Import;
		if (/\bnew\s+\w+/.test(context)) return ReferenceType.Instantiation;
		if (/\bextends\s+\w+/.test(context)) return ReferenceType.Inheritance;
		if (/\bimplements\s+\w+/.test(context)) return ReferenceType.Inheritance;
		if (/\.\w+\s*\(/.test(context)) return ReferenceType.MethodCall;
		if (/:\s*\w+/.test(context)) return ReferenceType.TypeAnnotation;
		return ReferenceType.Unknown;
	}
}

// ==================== 第2层：AST 分析 ====================

export class Layer2_ASTSearch {
	constructor(
		private workspaceRoot: string,
		private getParser: (lang: string) => Promise<any>
	) {}

	async findReferences(symbol: string, language: string = 'java'): Promise<Reference[]> {
		const results: Reference[] = [];

		try {
			// 1. 推断相关目录以缩小搜索范围
			const candidateDirs = this.inferRelevantDirs(symbol);
			console.log(`[Layer2] 搜索范围: ${candidateDirs.join(', ')}`);

			// 2. 获取 Tree-sitter parser
			const parser = await this.getParser(language);

			// 3. 扫描候选目录
			for (const dir of candidateDirs) {
				const pattern = path.join(this.workspaceRoot, dir, `**/*.${this.getExtension(language)}`);
				const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');

				for (const fileUri of files) {
					const fileRefs = await this.analyzeFile(fileUri, symbol, parser);
					results.push(...fileRefs);
				}
			}

			return results;
		} catch (error) {
			console.error('[Layer2] AST 扫描失败:', error);
			return [];
		}
	}

	private inferRelevantDirs(symbol: string): string[] {
		// 根据符号名称推断可能的目录
		const dirs = ['**']; // 默认全局搜索

		// 启发式规则
		if (symbol.endsWith('VO')) {
			dirs.unshift('**/vo', '**/dto', '**/model');
		}
		if (symbol.endsWith('Service') || symbol.endsWith('Servcie')) {
			dirs.unshift('**/service');
		}
		if (symbol.endsWith('Controller')) {
			dirs.unshift('**/controller');
		}
		if (symbol.endsWith('Mapper') || symbol.endsWith('DAO')) {
			dirs.unshift('**/mapper', '**/dao');
		}

		return dirs;
	}

	private async analyzeFile(
		fileUri: vscode.Uri,
		symbol: string,
		parser: any
	): Promise<Reference[]> {
		const results: Reference[] = [];

		try {
			const document = await vscode.workspace.openTextDocument(fileUri);
			const text = document.getText();

			// 解析 AST
			const tree = parser.parse(text);

			// 查找所有引用节点
			const imports = this.findImports(tree.rootNode, symbol, document);
			const usages = this.findUsages(tree.rootNode, symbol, document);
			const inheritance = this.findInheritance(tree.rootNode, symbol, document);

			results.push(...imports, ...usages, ...inheritance);
		} catch (error) {
			console.error(`[Layer2] 分析文件失败 ${fileUri.fsPath}:`, error);
		} finally {
			parser.delete?.();
		}

		return results;
	}

	private findImports(node: any, symbol: string, document: vscode.TextDocument): Reference[] {
		const results: Reference[] = [];

		// Java import 查询: (import_declaration) @import
		this.traverseNode(node, (n) => {
			if (n.type === 'import_declaration') {
				const text = document.getText(
					new vscode.Range(
						document.positionAt(n.startIndex),
						document.positionAt(n.endIndex)
					)
				);

				if (text.includes(symbol)) {
					const position = document.positionAt(n.startIndex);
					results.push({
						file: vscode.workspace.asRelativePath(document.uri),
						line: position.line + 1,
						column: position.character + 1,
						type: ReferenceType.Import,
						context: text,
						source: 'ast',
					});
				}
			}
		});

		return results;
	}

	private findUsages(node: any, symbol: string, document: vscode.TextDocument): Reference[] {
		const results: Reference[] = [];

		// 查找所有标识符节点
		this.traverseNode(node, (n) => {
			if (n.type === 'identifier' || n.type === 'type_identifier') {
				const text = document.getText(
					new vscode.Range(
						document.positionAt(n.startIndex),
						document.positionAt(n.endIndex)
					)
				);

				if (text === symbol) {
					const position = document.positionAt(n.startIndex);
					const lineText = document.lineAt(position.line).text;

					results.push({
						file: vscode.workspace.asRelativePath(document.uri),
						line: position.line + 1,
						column: position.character + 1,
						type: this.inferTypeFromNode(n),
						context: lineText.trim(),
						source: 'ast',
					});
				}
			}
		});

		return results;
	}

	private findInheritance(node: any, symbol: string, document: vscode.TextDocument): Reference[] {
		const results: Reference[] = [];

		// 查找 extends/implements
		this.traverseNode(node, (n) => {
			if (n.type === 'superclass' || n.type === 'super_interfaces') {
				const text = document.getText(
					new vscode.Range(
						document.positionAt(n.startIndex),
						document.positionAt(n.endIndex)
					)
				);

				if (text.includes(symbol)) {
					const position = document.positionAt(n.startIndex);
					const lineText = document.lineAt(position.line).text;

					results.push({
						file: vscode.workspace.asRelativePath(document.uri),
						line: position.line + 1,
						column: position.character + 1,
						type: ReferenceType.Inheritance,
						context: lineText.trim(),
						source: 'ast',
					});
				}
			}
		});

		return results;
	}

	private traverseNode(node: any, callback: (node: any) => void): void {
		callback(node);
		for (let i = 0; i < node.childCount; i++) {
			this.traverseNode(node.child(i), callback);
		}
	}

	private inferTypeFromNode(node: any): ReferenceType {
		const parent = node.parent;
		if (!parent) return ReferenceType.Unknown;

		if (parent.type === 'variable_declarator') return ReferenceType.VariableDeclaration;
		if (parent.type === 'method_invocation') return ReferenceType.MethodCall;
		if (parent.type === 'object_creation_expression') return ReferenceType.Instantiation;
		if (parent.type === 'type_identifier') return ReferenceType.TypeAnnotation;

		return ReferenceType.Unknown;
	}

	private getExtension(language: string): string {
		const extensions: Record<string, string> = {
			java: 'java',
			typescript: 'ts',
			javascript: 'js',
			python: 'py',
		};
		return extensions[language] || language;
	}
}

// ==================== 第3层：文本全量扫描 ====================

export class Layer3_TextSearch {
	constructor(private workspaceRoot: string) {}

	async findReferences(symbol: string, filePattern: string = '*.java'): Promise<Reference[]> {
		try {
			// 使用 ripgrep 进行全量扫描
			const { stdout } = await execAsync(
				`rg -n --type-add 'source:${filePattern}' -t source --context 2 "\\b${symbol}\\b" "${this.workspaceRoot}"`,
				{ maxBuffer: 10 * 1024 * 1024 } // 10MB buffer
			);

			return this.parseRipgrepOutput(stdout, symbol);
		} catch (error: any) {
			// ripgrep 未找到结果时 exit code = 1
			if (error.code === 1) {
				return [];
			}
			console.error('[Layer3] Ripgrep 扫描失败:', error);
			return [];
		}
	}

	private parseRipgrepOutput(output: string, symbol: string): Reference[] {
		const results: Reference[] = [];
		const lines = output.split('\n');

		let currentFile = '';
		let currentLine = 0;
		let contextBuffer: string[] = [];

		for (const line of lines) {
			// 解析 ripgrep 输出格式: file:line:content
			const match = line.match(/^(.+?):(\d+):(.*)$/);
			if (match) {
				const [, file, lineStr, content] = match;
				currentFile = file.replace(this.workspaceRoot, '').replace(/^[/\\]/, '');
				currentLine = parseInt(lineStr);

				// 过滤假阳性
				if (!this.isFalsePositive(content, symbol)) {
					results.push({
						file: currentFile,
						line: currentLine,
						type: this.inferTypeFromContent(content, symbol),
						context: content.trim(),
						source: 'text',
					});
				}
			}
		}

		return results;
	}

	private isFalsePositive(content: string, symbol: string): boolean {
		const trimmed = content.trim();

		// 单行注释
		if (trimmed.startsWith('//')) return true;

		// 多行注释
		if (trimmed.startsWith('/*') || trimmed.startsWith('*')) return true;

		// 字符串字面量（简单检测）
		const symbolIndex = content.indexOf(symbol);
		if (symbolIndex > 0) {
			const before = content.substring(0, symbolIndex);
			const quoteCount = (before.match(/"/g) || []).length;
			if (quoteCount % 2 === 1) return true; // 在字符串内
		}

		return false;
	}

	private inferTypeFromContent(content: string, symbol: string): ReferenceType {
		if (/^import\s+/.test(content.trim())) return ReferenceType.Import;
		if (new RegExp(`\\bnew\\s+${symbol}\\b`).test(content)) return ReferenceType.Instantiation;
		if (new RegExp(`\\bextends\\s+${symbol}\\b`).test(content)) return ReferenceType.Inheritance;
		if (new RegExp(`\\bimplements\\s+${symbol}\\b`).test(content)) return ReferenceType.Inheritance;
		if (new RegExp(`\\.${symbol}\\s*\\(`).test(content)) return ReferenceType.MethodCall;
		return ReferenceType.Unknown;
	}
}

// ==================== 第4层：Git 历史回溯 ====================

export class Layer4_GitHistorySearch {
	constructor(private workspaceRoot: string) {}

	async findReferences(symbol: string, filePattern: string = '*.java'): Promise<Reference[]> {
		try {
			// 1. 搜索包含该符号的所有提交
			const { stdout: logOutput } = await execAsync(
				`git -C "${this.workspaceRoot}" log --all --full-history --source --pickaxe-regex -S"\\b${symbol}\\b" --pretty=format:"%H|%ai|%s" -- "${filePattern}"`,
				{ maxBuffer: 5 * 1024 * 1024 }
			);

			if (!logOutput.trim()) {
				console.log('[Layer4] Git 历史中未找到该符号');
				return [];
			}

			// 2. 取最后一次包含该符号的提交
			const commits = logOutput.split('\n').filter(Boolean);
			const lastCommit = commits[0].split('|')[0];

			console.log(`[Layer4] 在提交 ${lastCommit.substring(0, 8)} 中搜索引用`);

			// 3. 在该提交中搜索所有引用
			const { stdout: grepOutput } = await execAsync(
				`git -C "${this.workspaceRoot}" grep -n "${symbol}" ${lastCommit} -- "${filePattern}"`,
				{ maxBuffer: 5 * 1024 * 1024 }
			);

			return this.parseGitGrepOutput(grepOutput, symbol, lastCommit);
		} catch (error: any) {
			if (error.code === 1) {
				return []; // 未找到结果
			}
			console.error('[Layer4] Git 历史搜索失败:', error);
			return [];
		}
	}

	private parseGitGrepOutput(output: string, symbol: string, commit: string): Reference[] {
		const results: Reference[] = [];
		const lines = output.split('\n').filter(Boolean);

		for (const line of lines) {
			// 格式: commit:file:line:content
			const match = line.match(/^[^:]+:(.+?):(\d+):(.*)$/);
			if (match) {
				const [, file, lineStr, content] = match;

				results.push({
					file,
					line: parseInt(lineStr),
					type: ReferenceType.Unknown,
					context: `[历史@${commit.substring(0, 8)}] ${content.trim()}`,
					source: 'git',
				});
			}
		}

		return results;
	}
}

// ==================== 协调器：多层级引用发现 ====================

export class MultiLayerReferenceDiscovery {
	private layer1: Layer1_IndexSearch;
	private layer2: Layer2_ASTSearch;
	private layer3: Layer3_TextSearch;
	private layer4: Layer4_GitHistorySearch;

	constructor(
		workspaceRoot: string,
		indexClient: any,
		getParser: (lang: string) => Promise<any>
	) {
		this.layer1 = new Layer1_IndexSearch(workspaceRoot, indexClient);
		this.layer2 = new Layer2_ASTSearch(workspaceRoot, getParser);
		this.layer3 = new Layer3_TextSearch(workspaceRoot);
		this.layer4 = new Layer4_GitHistorySearch(workspaceRoot);
	}

	/**
	 * 使用4层防御策略查找所有引用
	 */
	async findAllReferences(
		symbol: string,
		options: {
			language?: string;
			filePattern?: string;
			includeGitHistory?: boolean;
		} = {}
	): Promise<Reference[]> {
		const { language = 'java', filePattern = '*.java', includeGitHistory = false } = options;

		const allReferences: Reference[] = [];
		let currentLayer = 1;

		// 第1层：索引查询
		console.log(`🔍 [Layer${currentLayer}] 查询代码索引...`);
		let refs = await this.layer1.findReferences(symbol);
		allReferences.push(...refs);

		if (refs.length === 0) {
			// 第2层：AST 扫描
			currentLayer++;
			console.warn(`⚠️  索引未命中，启动 [Layer${currentLayer}] AST 扫描...`);
			refs = await this.layer2.findReferences(symbol, language);
			allReferences.push(...refs);
		}

		if (refs.length === 0) {
			// 第3层：文本全量扫描
			currentLayer++;
			console.warn(`⚠️  AST 扫描无结果，启动 [Layer${currentLayer}] 文本全量扫描...`);
			refs = await this.layer3.findReferences(symbol, filePattern);
			allReferences.push(...refs);
		}

		if (refs.length === 0 && includeGitHistory) {
			// 第4层：Git 历史回溯
			currentLayer++;
			console.warn(`⚠️  工作区无引用，启动 [Layer${currentLayer}] Git 历史回溯...`);
			refs = await this.layer4.findReferences(symbol, filePattern);
			allReferences.push(...refs);
		}

		// 去重（同一位置可能被多层发现）
		const uniqueRefs = this.deduplicateReferences(allReferences);

		console.log(`✅ 共发现 ${uniqueRefs.length} 个引用（来源: ${this.summarizeSources(uniqueRefs)}）`);

		return uniqueRefs;
	}

	private deduplicateReferences(refs: Reference[]): Reference[] {
		const seen = new Set<string>();
		return refs.filter((ref) => {
			const key = `${ref.file}:${ref.line}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	private summarizeSources(refs: Reference[]): string {
		const sources = refs.map((r) => r.source);
		const counts = sources.reduce((acc, s) => {
			acc[s] = (acc[s] || 0) + 1;
			return acc;
		}, {} as Record<string, number>);

		return Object.entries(counts)
			.map(([source, count]) => `${source}=${count}`)
			.join(', ');
	}

	/**
	 * 分析依赖关系
	 */
	async analyzeDependencies(refs: Reference[]): Promise<DependencyInfo[]> {
		// TODO: 实现依赖分析
		// 1. 从引用中提取符号名称
		// 2. 构建依赖图（uses/extends/implements/contains）
		// 3. 识别传递依赖
		return [];
	}

	/**
	 * 构建删除计划
	 */
	async buildDeletionPlan(symbol: string): Promise<DeletionPlan> {
		const references = await this.findAllReferences(symbol, { includeGitHistory: false });
		const dependencies = await this.analyzeDependencies(references);

		// 估计影响范围
		const uniqueFiles = new Set(references.map((r) => r.file));
		const impact: ImpactEstimate = {
			fileCount: uniqueFiles.size,
			lineCount: references.length,
			risk: uniqueFiles.size > 10 ? 'high' : uniqueFiles.size > 3 ? 'medium' : 'low',
		};

		return {
			references,
			dependencies,
			impact,
		};
	}
}
