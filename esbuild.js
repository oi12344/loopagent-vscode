const esbuild = require("esbuild");
const { copyTreeSitterAssets } = require("./scripts/treeSitterAssets");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  minify: production,
  outfile: "dist/extension.js",
  platform: "node",
  sourcemap: !production,
  target: "node22",
};

const sqliteWorkerConfig = {
  ...extensionConfig,
  entryPoints: ["src/extension/intelligence/storage/sqliteIndexWorker.ts"],
  outfile: "dist/sqliteIndexWorker.js",
};

const webviewConfig = {
  entryPoints: ["src/webview/main.tsx"],
  bundle: true,
  format: "iife",
  minify: production,
  outfile: "dist/webview.js",
  platform: "browser",
  sourcemap: !production,
  target: "es2022",
};

async function build() {
  if (watch) {
    await copyTreeSitterAssets();
    const extensionContext = await esbuild.context(extensionConfig);
    const webviewContext = await esbuild.context(webviewConfig);
    const sqliteWorkerContext = await esbuild.context(sqliteWorkerConfig);
    await Promise.all([
      extensionContext.watch(),
      webviewContext.watch(),
      sqliteWorkerContext.watch(),
    ]);
    console.log("Watching extension, webview, and sqlite worker builds...");
    return;
  }

  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewConfig),
    esbuild.build(sqliteWorkerConfig),
  ]);
  await copyTreeSitterAssets();
}

if (require.main === module) {
  build().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  build,
  extensionConfig,
  sqliteWorkerConfig,
  webviewConfig,
};
