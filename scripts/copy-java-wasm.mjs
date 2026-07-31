import { copyFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

async function copyJavaWasm() {
  const source = join(projectRoot, "node_modules", "tree-sitter-java", "tree-sitter-java.wasm");
  const dest = join(projectRoot, "dist", "tree-sitter-java.wasm");

  try {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(source, dest);
    console.log(`✅ 已复制 tree-sitter-java.wasm 到 ${dest}`);
  } catch (error) {
    console.error(`❌ 复制失败:`, error.message);
    process.exit(1);
  }
}

copyJavaWasm();
