import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { executeCommand } from "../../src/extension/agent/runCommandTool";

describe("runCommand 进度检查", () => {
  let abortController: AbortController;

  beforeEach(() => {
    abortController = new AbortController();
  });

  afterEach(() => {
    abortController.abort();
  });

  it("持续输出的命令应该延长超时", async () => {
    // 模拟每秒输出一次的命令,持续 90 秒
    const command =
      process.platform === "win32"
        ? `powershell -Command "1..90 | ForEach-Object { Write-Output $_; Start-Sleep -Seconds 1 }"`
        : `for i in {1..90}; do echo $i; sleep 1; done`;

    const startTime = Date.now();
    const result = await executeCommand(
      command,
      process.cwd(),
      abortController.signal,
      60_000, // 初始超时 60s
      1024 * 1024,
    );
    const duration = Date.now() - startTime;

    // 验证命令成功完成(不是超时)
    expect(result).toContain("Status: exited");
    expect(result).not.toContain("Status: timed_out");

    // 验证运行时间接近 90 秒(说明进度检查生效了)
    expect(duration).toBeGreaterThan(85_000);
    expect(duration).toBeLessThan(96_000); // 放宽到 96s,容忍调度延迟

    // 验证进度检查记录存在且显示 progressing
    expect(result).toContain("Progress checks:");
    expect(result).toContain("progressing");
  }, 120_000); // 测试超时设为 120 秒

  it("中途沉默的命令应该在容忍次数后终止", async () => {
    // 模拟输出 5 秒后沉默的命令
    const command =
      process.platform === "win32"
        ? `powershell -Command "1..5 | ForEach-Object { Write-Output $_; Start-Sleep -Seconds 1 }; Start-Sleep -Seconds 120"`
        : `for i in {1..5}; do echo $i; sleep 1; done; sleep 120`;

    const startTime = Date.now();
    const result = await executeCommand(
      command,
      process.cwd(),
      abortController.signal,
      300_000, // 初始超时 5 分钟
      1024 * 1024,
    );
    const duration = Date.now() - startTime;

    // 验证命令被超时终止
    expect(result).toContain("Status: timed_out");

    // 验证终止时间约为 5s(输出) + 3×30s(检查间隔) = 95s
    // 实际约 5s + 90s = 95s
    expect(duration).toBeGreaterThan(90_000);
    expect(duration).toBeLessThan(100_000); // 放宽容差

    // 验证进度检查记录显示先 progressing 后 stalled
    expect(result).toContain("Progress checks:");
    expect(result).toContain("stalled");
    expect(result).toMatch(/silent: 3/); // 连续沉默 3 次
  }, 150_000); // 测试超时延长到 150 秒

  it("立即挂死的命令应该快速超时", async () => {
    // 模拟立即挂死(不产生任何输出)的命令
    const command =
      process.platform === "win32"
        ? `powershell -Command "Start-Sleep -Seconds 120"`
        : `sleep 120`;

    const startTime = Date.now();
    const result = await executeCommand(
      command,
      process.cwd(),
      abortController.signal,
      300_000, // 初始超时 5 分钟
      1024 * 1024,
    );
    const duration = Date.now() - startTime;

    // 验证命令被超时终止
    expect(result).toContain("Status: timed_out");

    // 验证终止时间约为 3×30s = 90s(3 次连续沉默检查)
    expect(duration).toBeGreaterThan(85_000);
    expect(duration).toBeLessThan(96_000); // 放宽容差

    // 验证进度检查记录全是 stalled
    expect(result).toContain("Progress checks:");
    expect(result).toContain("stalled");
    expect(result).not.toContain("progressing");
    expect(result).toMatch(/silent: 3/); // 第 3 次检查时终止
  }, 120_000);

  it("超过绝对上限的命令应该强制终止", async () => {
    // 模拟持续输出但超过绝对上限的命令
    const command =
      process.platform === "win32"
        ? `powershell -Command "1..700 | ForEach-Object { Write-Output $_; Start-Sleep -Seconds 1 }"`
        : `for i in {1..700}; do echo $i; sleep 1; done`;

    const startTime = Date.now();
    const result = await executeCommand(
      command,
      process.cwd(),
      abortController.signal,
      60_000, // 初始超时 60s(但绝对上限是 10 分钟)
      1024 * 1024,
    );
    const duration = Date.now() - startTime;

    // 验证命令被超时终止
    expect(result).toContain("Status: timed_out");

    // 验证终止时间约为 10 分钟(绝对上限)
    expect(duration).toBeGreaterThan(595_000);
    expect(duration).toBeLessThan(605_000);

    // 验证进度检查记录显示多次 progressing
    expect(result).toContain("Progress checks:");
    expect(result).toContain("progressing");
  }, 620_000); // 测试超时设为 620 秒

  it("快速完成的命令不应触发进度检查", async () => {
    // 模拟立即完成的命令
    const command = process.platform === "win32" ? `echo hello` : `echo hello`;

    const startTime = Date.now();
    const result = await executeCommand(
      command,
      process.cwd(),
      abortController.signal,
      60_000,
      1024 * 1024,
    );
    const duration = Date.now() - startTime;

    // 验证命令正常退出
    expect(result).toContain("Status: exited");
    expect(result).toContain("Exit code: 0");

    // 验证运行时间很短(< 5 秒)
    expect(duration).toBeLessThan(5_000);

    // 验证没有进度检查记录(因为在第一次检查前就完成了)
    expect(result).not.toContain("Progress checks:");
  });
});
