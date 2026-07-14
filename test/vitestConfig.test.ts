import { describe, expect, it } from "vitest";

import config from "../vitest.config";

describe("Vitest configuration", () => {
  it("uses the Node environment by default", () => {
    expect(config.test?.environment).toBe("node");
  });

  it("excludes project-local worktrees from test discovery", () => {
    expect(config.test?.exclude).toContain(".worktrees/**");
  });
});
