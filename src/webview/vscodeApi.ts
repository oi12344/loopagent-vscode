import type { WebviewToHostMessage } from "../shared/messages";

export type VsCodeApi = {
  postMessage(message: WebviewToHostMessage): void;
};

type WebviewGlobal = typeof globalThis & {
  acquireVsCodeApi?: () => VsCodeApi;
};

let cachedVsCodeApi: VsCodeApi | null = null;

export function createDefaultVsCodeApi(): VsCodeApi {
  if (cachedVsCodeApi) {
    return cachedVsCodeApi;
  }

  const webviewGlobal = globalThis as WebviewGlobal;

  if (typeof webviewGlobal.acquireVsCodeApi === "function") {
    cachedVsCodeApi = webviewGlobal.acquireVsCodeApi();
    return cachedVsCodeApi;
  }

  cachedVsCodeApi = {
    postMessage: () => undefined,
  };

  return cachedVsCodeApi;
}

export function resetDefaultVsCodeApiForTests() {
  cachedVsCodeApi = null;
}