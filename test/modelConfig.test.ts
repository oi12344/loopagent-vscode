import { describe, expect, it } from "vitest";

import { createModelRuntimeConfig } from "../src/extension/model/modelRuntimeConfig";
import type { RunModelSelection } from "../src/shared/messages";

describe("createModelRuntimeConfig", () => {
  it("uses the per-run model selection before workspace model settings", () => {
    const selection: RunModelSelection = {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinking: "enabled",
    };

    expect(
      createModelRuntimeConfig(
        {
          provider: "deepseek",
          model: "workspace-model",
          thinking: "disabled",
        },
        selection,
      ),
    ).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinking: "enabled",
    });
  });

  it("keeps the workspace API key for the configured provider", () => {
    const selection: RunModelSelection = {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinking: "enabled",
    };

    expect(
      createModelRuntimeConfig(
        {
          provider: "deepseek",
          model: "workspace-model",
          thinking: "disabled",
          apiKey: "workspace-key",
        },
        selection,
      ),
    ).toMatchObject({
      provider: "deepseek",
      apiKey: "workspace-key",
    });
  });

  it("falls back to workspace model settings when no per-run selection is provided", () => {
    expect(
      createModelRuntimeConfig({
        provider: "deepseek",
        model: "workspace-model",
        thinking: "disabled",
      }),
    ).toMatchObject({
      provider: "deepseek",
      model: "workspace-model",
      thinking: "disabled",
    });
  });
});
