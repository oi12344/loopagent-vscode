const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const extensionConfig = {
  bundle: true,
  entryPoints: ["src/extension.ts"],
  external: ["vscode"],
  format: "cjs",
  minify: production,
  outfile: "dist/extension.js",
  platform: "node",
  sourcemap: !production,
  target: "node20",
};

const webviewConfig = {
  bundle: true,
  entryPoints: ["src/webview/main.tsx"],
  format: "iife",
  minify: production,
  outfile: "dist/webview.js",
  platform: "browser",
  sourcemap: !production,
  target: "es2022",
};

async function build() {
  if (watch) {
    const extensionContext = await esbuild.context(extensionConfig);
    const webviewContext = await esbuild.context(webviewConfig);
    await Promise.all([extensionContext.watch(), webviewContext.watch()]);
    console.log("Watching extension and webview bundles...");
    return;
  }

  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
