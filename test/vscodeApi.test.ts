import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultVsCodeApi, resetDefaultVsCodeApiForTests } from "../src/webview/vscodeApi";
import type { VsCodeApi } from "../src/webview/vscodeApi";

declare global {
  var acquireVsCodeApi: undefined | (() => VsCodeApi);
}

afterEach(() => {
  resetDefaultVsCodeApiForTests();
  delete globalThis.acquireVsCodeApi;
});

describe("createDefaultVsCodeApi", () => {
  it("acquires the VS Code API only once", () => {
    const api: VsCodeApi = { postMessage: vi.fn() };
    const acquireVsCodeApi = vi.fn(() => api);
    globalThis.acquireVsCodeApi = acquireVsCodeApi;

    const first = createDefaultVsCodeApi();
    const second = createDefaultVsCodeApi();

    expect(first).toBe(api);
    expect(second).toBe(api);
    expect(acquireVsCodeApi).toHaveBeenCalledTimes(1);
  });
});