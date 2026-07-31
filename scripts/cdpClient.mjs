// 精简的 CDP 客户端，供 VS Code 宿主 E2E 脚本复用。
const CONNECTION_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;

export const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

export async function listTargets(port) {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  let response;
  try {
    response = await fetch(endpoint, {
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `无法访问 VS Code CDP 目标列表 ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw new Error(`CDP 目标列表返回 HTTP ${response.status}`);
  }

  const targets = await response.json();
  if (!Array.isArray(targets)) {
    throw new Error("CDP 目标列表返回了非数组数据");
  }
  return targets;
}

export async function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  let closed = false;

  const rejectPending = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };

  await new Promise((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => {
      socket.close();
      rejectOpen(new Error(`连接 CDP WebSocket 超时: ${webSocketDebuggerUrl}`));
    }, CONNECTION_TIMEOUT_MS);
    const cleanup = () => clearTimeout(timeout);

    socket.addEventListener(
      "open",
      () => {
        cleanup();
        resolveOpen();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        cleanup();
        rejectOpen(new Error(`连接 CDP WebSocket 失败: ${webSocketDebuggerUrl}`));
      },
      { once: true },
    );
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      rejectPending(new Error("CDP WebSocket 返回了非法 JSON"));
      return;
    }

    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) {
      request.reject(
        new Error(
          `CDP ${request.method} 失败: ${message.error.message ?? JSON.stringify(message.error)}`,
        ),
      );
    } else {
      request.resolve(message.result);
    }
  });

  socket.addEventListener("error", () => {
    rejectPending(new Error("CDP WebSocket 出错"));
  });
  socket.addEventListener("close", () => {
    closed = true;
    rejectPending(new Error("CDP WebSocket 已关闭"));
  });

  function send(method, params = {}) {
    return new Promise((resolveRequest, rejectRequest) => {
      if (closed || socket.readyState !== WebSocket.OPEN) {
        rejectRequest(new Error(`无法发送 ${method}: CDP WebSocket 未打开`));
        return;
      }

      const id = nextId++;
      const timeout = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`等待 CDP ${method} 超时 ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { method, resolve: resolveRequest, reject: rejectRequest, timeout });

      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(id);
        rejectRequest(
          new Error(
            `发送 CDP ${method} 失败: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  async function evaluate(expression) {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          "CDP 求值失败",
      );
    }
    return response.result?.value;
  }

  function close() {
    rejectPending(new Error("CDP 会话已关闭"));
    if (closed || socket.readyState === WebSocket.CLOSED) return Promise.resolve();

    return new Promise((resolveClose) => {
      const timeout = setTimeout(resolveClose, 1_000);
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timeout);
          resolveClose();
        },
        { once: true },
      );
      socket.close();
    });
  }

  return { send, evaluate, close };
}

// 窗口刚启动时远程调试端口要几秒才开始监听，轮询到可用为止。
export async function waitForCdp(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(port);
      if (targets.length > 0) return targets;
    } catch (error) {
      lastError = error;
    }
    await delay(1_000);
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`等待 CDP 端口 ${port} 就绪超时 ${timeoutMs}ms${detail}`);
}

export async function findWorkbenchTarget(port) {
  const targets = await listTargets(port);
  const workbench =
    targets.find(
      (target) =>
        target.webSocketDebuggerUrl && String(target.url).includes("workbench.html"),
    ) ??
    targets.find(
      (target) =>
        target.webSocketDebuggerUrl &&
        String(target.title).toLowerCase().includes("visual studio code"),
    );
  if (!workbench?.webSocketDebuggerUrl) {
    throw new Error("未找到 VS Code workbench 的 CDP 目标");
  }
  return workbench;
}

export async function findWebviewTarget(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(port);
      const candidates = targets.filter((candidate) => {
        const identity = `${candidate.title ?? ""} ${candidate.url ?? ""}`.toLowerCase();
        return (
          candidate.webSocketDebuggerUrl &&
          !identity.includes("workbench.html") &&
          (identity.includes("vscode-webview") || identity.includes("loopagent"))
        );
      });
      candidates.sort((left, right) => {
        const rank = (candidate) => {
          const identity = `${candidate.title ?? ""} ${candidate.url ?? ""}`.toLowerCase();
          return identity.includes("loopagent") ? 0 : 1;
        };
        return rank(left) - rank(right);
      });
      const target = candidates[0];
      if (target) return target;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`未在 ${timeoutMs}ms 内找到 LoopAgent Webview 的 CDP 目标${detail}`);
}

export async function openLoopAgentView(session, timeoutMs = 20_000) {
  await session.send("Runtime.enable");
  await session.send("Page.enable");
  await session.send("Page.bringToFront");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const opened = await session.evaluate(`(() => {
      const activityEntry = [...document.querySelectorAll("a")].find(
        (element) => element.getAttribute("aria-label") === "LoopAgent",
      );
      if (!(activityEntry instanceof HTMLElement)) return false;
      if (activityEntry.parentElement?.getAttribute("aria-selected") !== "true") {
        activityEntry.click();
      }
      return true;
    })()`);
    if (opened) {
      await delay(2_000);
      return;
    }
    await delay(500);
  }
  throw new Error(`未在 ${timeoutMs}ms 内找到 LoopAgent 活动栏入口`);
}
