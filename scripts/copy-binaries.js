/**
 * 复制打包后的二进制文件到扩展目录
 * 用于打包完整版 VSIX
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist', 'vision_server');
const BIN_DIR = path.join(PROJECT_ROOT, 'bin');

console.log('📦 复制视觉服务二进制文件...');
console.log('');

// 创建 bin 目录
if (!fs.existsSync(BIN_DIR)) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
}

// 检查构建输出
if (!fs.existsSync(DIST_DIR)) {
  console.error('❌ 构建输出不存在:', DIST_DIR);
  console.error('   请先运行: npm run build:vision');
  process.exit(1);
}

// 复制整个 vision_server 目录
console.log('源目录:', DIST_DIR);
console.log('目标目录:', BIN_DIR);
console.log('');

const copyRecursive = (src, dest) => {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      console.log('✅', path.relative(PROJECT_ROOT, destPath));
    }
  }
};

try {
  copyRecursive(DIST_DIR, path.join(BIN_DIR, 'vision_server'));

  console.log('');
  console.log('🎉 复制完成！');
  console.log('');

  // 统计大小
  const getSize = (dir) => {
    let size = 0;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        size += getSize(p);
      } else {
        size += fs.statSync(p).size;
      }
    }

    return size;
  };

  const totalSize = getSize(path.join(BIN_DIR, 'vision_server'));
  const sizeMB = (totalSize / (1024 * 1024)).toFixed(1);

  console.log(`📊 总大小: ${sizeMB} MB`);
  console.log('');
  console.log('▶️  现在可以打包完整版 VSIX:');
  console.log('   vsce package --out dist/loopagent-full.vsix');

} catch (error) {
  console.error('❌ 复制失败:', error.message);
  process.exit(1);
}
