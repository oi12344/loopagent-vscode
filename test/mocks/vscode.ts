function createDisposable(): { dispose(): void } {
  return { dispose: () => undefined };
}

export const commands = {
  executeCommand: async () => undefined,
  registerCommand: () => createDisposable(),
};

export const window = {
  registerWebviewViewProvider: () => createDisposable(),
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showInputBox: async () => undefined,
};

export const workspace = {
  getConfiguration: (section?: string) => ({
    get: (key: string, defaultValue?: unknown) => defaultValue,
  }),
  workspaceFolders: undefined,
  name: "test-workspace",
};

export const Uri = {
  joinPath: (_base: unknown, ...segments: string[]) => ({
    toString: () => segments.join("/"),
  }),
};
