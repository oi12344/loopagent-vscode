import { opendir, readFile } from "fs/promises";
import { join } from "path";

const PROJECT_PATH = "D:\\zz\\yguc";
const INDEX_PATH = join(PROJECT_PATH, ".loopagent", "code-index.sqlite");

console.log("=".repeat(60));
console.log("Java 索引诊断工具");
console.log("=".repeat(60));

// 1. 检查 Java 文件数量
console.log("\n[步骤1] 统计 Java 文件数量");
let javaFileCount = 0;

async function countJavaFiles(dir) {
  try {
    const entries = await opendir(dir);
    for await (const entry of entries) {
      const fullPath = join(dir, entry.name);

      // 跳过常见的排除目录
      if (entry.isDirectory()) {
        if (["node_modules", "dist", ".git", "target"].includes(entry.name)) {
          continue;
        }
        await countJavaFiles(fullPath);
      } else if (entry.name.endsWith(".java")) {
        javaFileCount++;
        if (javaFileCount <= 5) {
          console.log(`  发现: ${fullPath}`);
        }
      }
    }
  } catch (error) {
    // 忽略权限错误等
  }
}

await countJavaFiles(PROJECT_PATH);
console.log(`\n总共发现 ${javaFileCount} 个 Java 文件`);

// 2. 检查索引文件
console.log("\n[步骤2] 检查索引文件");
try {
  const { stat } = await import("fs/promises");
  const stats = await stat(INDEX_PATH);
  console.log(`  索引文件大小: ${(stats.size / 1024).toFixed(2)} KB`);
  console.log(`  最后修改时间: ${stats.mtime.toLocaleString()}`);
} catch (error) {
  console.log(`  索引文件不存在或无法访问: ${error.message}`);
}

// 3. 读取并显示示例 Java 文件内容
console.log("\n[步骤3] 读取示例 LogisticsService.java");
const serviceFile = join(PROJECT_PATH, "yguc-biz/src/main/java/com/sunshine/procurement/service/LogisticsService.java");
try {
  const content = await readFile(serviceFile, "utf-8");
  console.log(`  文件大小: ${content.length} 字符`);
  console.log(`  前 200 字符:\n${content.slice(0, 200)}...`);

  // 检查关键词
  const keywords = ["LogisticsService", "addLogisticsInfo", "interface", "class"];
  console.log("\n  关键词出现次数:");
  for (const keyword of keywords) {
    const count = (content.match(new RegExp(keyword, "g")) || []).length;
    console.log(`    ${keyword}: ${count} 次`);
  }
} catch (error) {
  console.log(`  无法读取文件: ${error.message}`);
}

console.log("\n" + "=".repeat(60));
console.log("诊断完成");
console.log("=".repeat(60));
