/**
 * 自动恢复系统集成验证脚本
 *
 * 运行此脚本验证自动恢复系统是否正确集成
 */

const fs = require('fs');
const path = require('path');

const REQUIRED_FILES = [
  'src/extension/agent/smartCommandExecutor.ts',
  'src/extension/agent/autoRecoveryOrchestrator.ts',
  'src/extension/agent/autoRecoveryIntegration.ts',
  'docs/auto-recovery-system.md',
  'docs/auto-recovery-deployment.md',
];

const MODIFIED_FILES = [
  'src/extension/agent/runCommandTool.ts',
  'src/extension.ts',
  'src/extension/model/providerRegistry.ts',
];

const COMPILED_MARKERS = [
  { file: 'dist/extension.js', marker: 'SmartCommandExecutor' },
  { file: 'dist/extension.js', marker: 'enableAutoRecovery' },
  { file: 'dist/extension.js', marker: 'alternatives' },
  { file: 'dist/extension.js', marker: 'successProbability' },
];

console.log('🔍 验证自动恢复系统集成...\n');

let passed = 0;
let failed = 0;

// 检查新增文件
console.log('📁 检查新增文件:');
for (const file of REQUIRED_FILES) {
  const exists = fs.existsSync(file);
  if (exists) {
    const stat = fs.statSync(file);
    console.log(`  ✅ ${file} (${stat.size} bytes)`);
    passed++;
  } else {
    console.log(`  ❌ ${file} - 文件不存在`);
    failed++;
  }
}

// 检查修改文件
console.log('\n📝 检查修改文件:');
for (const file of MODIFIED_FILES) {
  const exists = fs.existsSync(file);
  if (exists) {
    const content = fs.readFileSync(file, 'utf8');

    // 特定检查
    let checks = [];
    if (file.includes('runCommandTool.ts')) {
      checks = [
        { pattern: /SmartCommandExecutor/g, name: 'SmartCommandExecutor import' },
        { pattern: /enableAutoRecovery/g, name: 'enableAutoRecovery option' },
        { pattern: /formatCommandResultForAgent/g, name: 'JSON formatter' },
      ];
    } else if (file.includes('extension.ts')) {
      checks = [
        { pattern: /commandOutputChannel/g, name: 'commandOutputChannel' },
        { pattern: /enableAutoRecovery:\s*true/g, name: 'enableAutoRecovery: true' },
      ];
    } else if (file.includes('providerRegistry.ts')) {
      checks = [
        { pattern: /runCommand Auto-Recovery/g, name: 'Auto-Recovery guidance' },
        { pattern: /error\.alternatives/g, name: 'alternatives guidance' },
      ];
    }

    let fileOk = true;
    for (const check of checks) {
      if (check.pattern.test(content)) {
        console.log(`  ✅ ${file} - ${check.name}`);
        passed++;
      } else {
        console.log(`  ❌ ${file} - 缺少 ${check.name}`);
        failed++;
        fileOk = false;
      }
    }

    if (checks.length === 0) {
      console.log(`  ✅ ${file}`);
      passed++;
    }
  } else {
    console.log(`  ❌ ${file} - 文件不存在`);
    failed++;
  }
}

// 检查编译产物
console.log('\n🔨 检查编译产物:');
for (const { file, marker } of COMPILED_MARKERS) {
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes(marker)) {
      console.log(`  ✅ ${file} 包含 ${marker}`);
      passed++;
    } else {
      console.log(`  ❌ ${file} 缺少 ${marker}`);
      failed++;
    }
  } else {
    console.log(`  ❌ ${file} - 文件不存在`);
    failed++;
  }
}

// 检查代码质量
console.log('\n📊 代码质量检查:');

// 检查 smartCommandExecutor.ts 的行数
const smartExecutorPath = 'src/extension/agent/smartCommandExecutor.ts';
if (fs.existsSync(smartExecutorPath)) {
  const lines = fs.readFileSync(smartExecutorPath, 'utf8').split('\n').length;
  if (lines >= 680 && lines <= 700) {
    console.log(`  ✅ smartCommandExecutor.ts: ${lines} 行 (预期 ~689)`);
    passed++;
  } else {
    console.log(`  ⚠️  smartCommandExecutor.ts: ${lines} 行 (预期 ~689)`);
  }
}

// 检查 autoRecoveryOrchestrator.ts 的行数
const orchestratorPath = 'src/extension/agent/autoRecoveryOrchestrator.ts';
if (fs.existsSync(orchestratorPath)) {
  const lines = fs.readFileSync(orchestratorPath, 'utf8').split('\n').length;
  if (lines >= 520 && lines <= 540) {
    console.log(`  ✅ autoRecoveryOrchestrator.ts: ${lines} 行 (预期 ~527)`);
    passed++;
  } else {
    console.log(`  ⚠️  autoRecoveryOrchestrator.ts: ${lines} 行 (预期 ~527)`);
  }
}

// 最终报告
console.log('\n' + '='.repeat(50));
console.log(`\n📊 验证结果: ${passed} 通过, ${failed} 失败\n`);

if (failed === 0) {
  console.log('✅ 自动恢复系统集成成功！');
  console.log('\n下一步:');
  console.log('  1. 按 F5 启动扩展开发主机');
  console.log('  2. 在测试工作区触发 LoopAgent 对话');
  console.log('  3. 尝试运行失败的命令（如 mvn clean install）');
  console.log('  4. 观察 Agent 是否自动执行备选方案');
  console.log('\n查看详细文档: docs/auto-recovery-deployment.md');
  process.exit(0);
} else {
  console.log('❌ 集成验证失败，请检查上述错误');
  process.exit(1);
}
