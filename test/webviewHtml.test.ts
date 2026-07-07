import { describe, expect, it } from "vitest";
import { createWebviewHtml } from "../src/extension/webviewHtml";

describe("createWebviewHtml", () => {
  it("includes a visible fallback and allows extension resources for scripts and styles", () => {
    const html = createWebviewHtml({
      cspSource: "vscode-webview://example",
      nonce: "abc123",
      scriptUri: "vscode-webview://example/dist/webview.js",
      styleUri: "vscode-webview://example/dist/webview.css",
    });

    expect(html).toContain("Loading LoopAgent...");
    expect(html).toContain("LoopAgent failed to load");
    expect(html).toContain('<style nonce="abc123">');
    expect(html).toContain("style-src vscode-webview://example 'nonce-abc123'");
    expect(html).toContain("script-src vscode-webview://example 'nonce-abc123'");
    expect(html).toContain("connect-src vscode-webview://example");
    expect(html).toContain('src="vscode-webview://example/dist/webview.js"');
    expect(html).toContain('href="vscode-webview://example/dist/webview.css"');
  });
});