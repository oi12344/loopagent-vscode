import { describe, expect, it } from "vitest";

import { resolveRole, ROLE_PROFILES } from "../../src/extension/agent/workflow/roleRegistry";

describe("resolveRole", () => {
  it("defaults to explorer when role is omitted", () => {
    expect(resolveRole(undefined).id).toBe("explorer");
  });

  it("resolves each known role to its own profile", () => {
    expect(resolveRole("explorer").id).toBe("explorer");
    expect(resolveRole("reviewer").id).toBe("reviewer");
    expect(resolveRole("planner").id).toBe("planner");
  });

  it("rejects an unknown role", () => {
    expect(() => resolveRole("unknown" as never)).toThrow(/unknown/i);
  });

  it("gives every role a non-empty system prompt and a read-only tool whitelist", () => {
    for (const profile of Object.values(ROLE_PROFILES)) {
      expect(profile.systemPrompt.trim().length).toBeGreaterThan(0);
      expect(profile.allowedTools.length).toBeGreaterThan(0);
      for (const tool of profile.allowedTools) {
        expect(["exploreCode", "readFile"]).toContain(tool);
      }
    }
  });

  it("gives each role a distinct system prompt", () => {
    const prompts = new Set(Object.values(ROLE_PROFILES).map((profile) => profile.systemPrompt));
    expect(prompts.size).toBe(Object.keys(ROLE_PROFILES).length);
  });
});
