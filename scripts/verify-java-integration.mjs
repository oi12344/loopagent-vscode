/**
 * Java 完整解析支持验证脚本
 *
 * 此脚本自动执行所有验证步骤
 */

import { exec } from "child_process";
import { promisify } from "util";
import { access, stat } from "fs/promises";
import { join } from "path";

const execAsync = promisify(exec);

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function getFileSize(path) {
  try {
    const stats = await stat(path);
    return stats.size;
  } catch {
    return 0;
  }
}

async function runCommand(command, description) {
  log(`\n[执行] ${description}`, colors.blue);
  log(`命令: ${command}`, colors.yellow);

  try {
    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300000
    });

    if (stdout) log(stdout);
    if (stderr) log(stderr, colors.yellow);

    log(`✅ ${description} - 成功`, colors.green);
    return { success: true, stdout, stderr };
  } catch (error) {
    log(`❌ ${description} - 失败`, colors.red);
    log(`错误: ${error.message}`, colors.red);
    if (error.stdout) log(`输出: ${error.stdout}`);
    if (error.stderr) log(`错误输出: ${error.stderr}`, colors.red);
    return { success: false, error: error.message };
  }
}

async function main() {
  log("=".repeat(60), colors.blue);
  log("Java 完整解析支持验证", colors.blue);
  log("=".repeat(60), colors.blue);

  const results = {
    steps: [],
    overallSuccess: true,
  };

  // 步骤 1: 检查依赖配置
  log("\n[步骤 1/7] 检查 package.json 配置", colors.blue);
  const packageJsonPath = "package.json";
  const packageJson = await import(`file:///${process.cwd()}/${packageJsonPath}`, {
    assert: { type: "json" },
  }).catch(() => null);

  if (packageJson?.default?.dependencies?.["tree-sitter-java"]) {
    log(`✅ tree-sitter-java 已添加到 dependencies`, colors.green);
    results.steps.push({ step: "package.json配置", success: true });
  } else {
    log(`❌ tree-sitter-java 未在 dependencies 中找到`, colors.red);
    results.steps.push({ step: "package.json配置", success: false });
    results.overallSuccess = false;
  }

  // 步骤 2: 安装依赖
  const installResult = await runCommand(
    "npm install",
    "步骤 2/7: 安装 npm 依赖"
  );
  results.steps.push({ step: "安装依赖", success: installResult.success });
  if (!installResult.success) results.overallSuccess = false;

  // 步骤 3: 检查 tree-sitter-java 是否安装成功
  log("\n[步骤 3/7] 验证 tree-sitter-java 安装", colors.blue);
  const javaWasmSource = "node_modules/tree-sitter-java/tree-sitter-java.wasm";
  const wasmExists = await fileExists(javaWasmSource);

  if (wasmExists) {
    const size = await getFileSize(javaWasmSource);
    log(`✅ tree-sitter-java.wasm 存在 (${(size / 1024).toFixed(2)} KB)`, colors.green);
    results.steps.push({ step: "WASM文件存在", success: true });
  } else {
    log(`❌ tree-sitter-java.wasm 不存在`, colors.red);
    results.steps.push({ step: "WASM文件存在", success: false });
    results.overallSuccess = false;
  }

  // 步骤 4: 复制 WASM 文件
  const copyResult = await runCommand(
    "node scripts/copy-java-wasm.mjs",
    "步骤 4/7: 复制 Java WASM 文件"
  );
  results.steps.push({ step: "复制WASM", success: copyResult.success });
  if (!copyResult.success) results.overallSuccess = false;

  // 步骤 5: 编译项目
  const compileResult = await runCommand(
    "npm run compile",
    "步骤 5/7: 编译项目"
  );
  results.steps.push({ step: "编译项目", success: compileResult.success });
  if (!compileResult.success) results.overallSuccess = false;

  // 步骤 6: 运行单元测试
  const testResult = await runCommand(
    "npm test -- javaAdapter.test.ts",
    "步骤 6/7: 运行 Java 适配器单元测试"
  );
  results.steps.push({ step: "单元测试", success: testResult.success });
  if (!testResult.success) results.overallSuccess = false;

  // 步骤 7: 检查构建产物
  log("\n[步骤 7/7] 检查构建产物", colors.blue);
  const distWasm = "dist/tree-sitter-java.wasm";
  const distWasmExists = await fileExists(distWasm);

  if (distWasmExists) {
    const size = await getFileSize(distWasm);
    log(`✅ dist/tree-sitter-java.wasm 存在 (${(size / 1024).toFixed(2)} KB)`, colors.green);
    results.steps.push({ step: "构建产物", success: true });
  } else {
    log(`❌ dist/tree-sitter-java.wasm 不存在`, colors.red);
    results.steps.push({ step: "构建产物", success: false });
    results.overallSuccess = false;
  }

  // 最终报告
  log("\n" + "=".repeat(60), colors.blue);
  log("验证结果汇总", colors.blue);
  log("=".repeat(60), colors.blue);

  for (const step of results.steps) {
    const icon = step.success ? "✅" : "❌";
    const color = step.success ? colors.green : colors.red;
    log(`${icon} ${step.step}`, color);
  }

  log("\n" + "=".repeat(60), colors.blue);
  if (results.overallSuccess) {
    log("🎉 所有验证步骤通过！", colors.green);
    log("\n下一步: 运行 E2E 测试验证完整功能", colors.blue);
    log("命令: node scripts/run-java-logistics-e2e.mjs", colors.yellow);
  } else {
    log("⚠️  部分验证步骤失败，请检查错误信息", colors.red);
    process.exit(1);
  }
}

main().catch((error) => {
  log(`\n❌ 验证脚本执行失败: ${error.message}`, colors.red);
  console.error(error);
  process.exit(1);
});
