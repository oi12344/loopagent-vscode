import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDeepSeekProvider } from "../src/extension/model/providers/deepseekProvider";
import type { ModelRequest } from "../src/extension/model/types";

describe("DeepSeek Provider", () => {
  const mockFetch = vi.fn();
  const apiKey = "test-api-key";
  const baseUrl = "https://api.deepseek.com";
  const model = "deepseek-v4-flash";

  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("thinking mode behavior", () => {
    it("应该在有工具时保留用户启用的思考模式", async () => {
      const provider = createDeepSeekProvider({
        apiKey,
        baseUrl,
        model,
        thinking: "enabled",
        fetch: mockFetch,
      });

      // 模拟成功的 SSE 响应
      const mockResponse = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"test"},"finish_reason":"stop"}]}\n\n'));
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      );

      mockFetch.mockResolvedValue(mockResponse);

      const request: ModelRequest = {
        messages: [{ role: "user", content: "test" }],
        signal: new AbortController().signal,
        tools: [
          {
            type: "function",
            function: {
              name: "readFile",
              description: "Read a file",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      };

      // 消费流以触发请求
      const stream = provider.stream(request);
      for await (const _ of stream) {
        // 消费所有事件
      }

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      expect(requestBody.thinking).toEqual({ type: "enabled" });
    });

    it("keeps thinking enabled when finalizing a tool-call history", async () => {
      const provider = createDeepSeekProvider({
        apiKey,
        baseUrl,
        model,
        thinking: "enabled",
        fetch: mockFetch,
      });

      mockFetch.mockResolvedValue(new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n'));
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ));

      const request: ModelRequest = {
        messages: [
          { role: "user", content: "inspect the repository" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "call-1",
              type: "function",
              function: { name: "readFile", arguments: '{"path":"README.md"}' },
            }],
          },
          { role: "tool", content: "contents", toolCallId: "call-1", name: "readFile" },
        ],
        signal: new AbortController().signal,
      };

      for await (const _ of provider.stream(request)) {
        // Consume the response so the request is sent.
      }

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.thinking).toEqual({ type: "enabled" });
    });

    it("应该在无工具时保留用户配置的思考模式", async () => {
      const provider = createDeepSeekProvider({
        apiKey,
        baseUrl,
        model,
        thinking: "enabled",
        fetch: mockFetch,
      });

      const mockResponse = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"test"},"finish_reason":"stop"}]}\n\n'));
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      );

      mockFetch.mockResolvedValue(mockResponse);

      const request: ModelRequest = {
        messages: [{ role: "user", content: "test" }],
        signal: new AbortController().signal,
        // 无工具
      };

      const stream = provider.stream(request);
      for await (const _ of stream) {
        // 消费所有事件
      }

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      // 验证思考模式保持启用
      expect(requestBody.thinking).toEqual({ type: "enabled" });
    });

    it("应该在工具数组为空时保留思考模式", async () => {
      const provider = createDeepSeekProvider({
        apiKey,
        baseUrl,
        model,
        thinking: "enabled",
        fetch: mockFetch,
      });

      const mockResponse = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"test"},"finish_reason":"stop"}]}\n\n'));
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      );

      mockFetch.mockResolvedValue(mockResponse);

      const request: ModelRequest = {
        messages: [{ role: "user", content: "test" }],
        signal: new AbortController().signal,
        tools: [], // 空数组
      };

      const stream = provider.stream(request);
      for await (const _ of stream) {
        // 消费所有事件
      }

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      // 验证思考模式保持启用（工具数组为空）
      expect(requestBody.thinking).toEqual({ type: "enabled" });
    });

    it("应该在默认思考模式为 disabled 时保持 disabled", async () => {
      const provider = createDeepSeekProvider({
        apiKey,
        baseUrl,
        model,
        thinking: "disabled",
        fetch: mockFetch,
      });

      const mockResponse = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"test"},"finish_reason":"stop"}]}\n\n'));
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      );

      mockFetch.mockResolvedValue(mockResponse);

      const request: ModelRequest = {
        messages: [{ role: "user", content: "test" }],
        signal: new AbortController().signal,
        // 无工具，但默认思考模式已是 disabled
      };

      const stream = provider.stream(request);
      for await (const _ of stream) {
        // 消费所有事件
      }

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      // 验证思考模式保持禁用
      expect(requestBody.thinking).toEqual({ type: "disabled" });
    });
  });

  describe("error handling", () => {
    it("应该在缺少 API key 时抛出错误", () => {
      const provider = createDeepSeekProvider({
        baseUrl,
        model,
      });

      const request: ModelRequest = {
        messages: [{ role: "user", content: "test" }],
        signal: new AbortController().signal,
      };

      expect(() => {
        provider.stream(request);
      }).toThrow("DeepSeek API key is not configured");
    });

    it("应该在 API key 为空字符串时抛出错误", () => {
      const provider = createDeepSeekProvider({
        apiKey: "   ",
        baseUrl,
        model,
      });

      const request: ModelRequest = {
        messages: [{ role: "user", content: "test" }],
        signal: new AbortController().signal,
      };

      expect(() => {
        provider.stream(request);
      }).toThrow("DeepSeek API key is not configured");
    });
  });
});
