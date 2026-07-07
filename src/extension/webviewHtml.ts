export type WebviewHtmlOptions = {
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
};

export function createWebviewHtml({ cspSource, nonce, scriptUri, styleUri }: WebviewHtmlOptions): string {
  return /* html */ `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src ${cspSource} 'nonce-${nonce}'; connect-src ${cspSource};" />
    <style nonce="${nonce}">
      body {
        background: var(--vscode-editor-background, #1e1e1e);
        color: var(--vscode-editor-foreground, #d4d4d4);
        font-family: var(--vscode-font-family, system-ui, sans-serif);
        margin: 0;
      }
      #root {
        height: 100vh;
      }
      .boot-error {
        color: var(--vscode-errorForeground, #f48771);
        white-space: pre-wrap;
      }
    </style>
    <link rel="stylesheet" href="${styleUri}" />
    <title>LoopAgent</title>
  </head>
  <body>
    <div id="root">Loading LoopAgent...</div>
    <script nonce="${nonce}">
      window.addEventListener("error", (event) => {
        const root = document.getElementById("root");
        if (root) {
          root.textContent = "LoopAgent failed to load\n" + event.message;
          root.className = "boot-error";
        }
      });
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}
