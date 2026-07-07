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
          provider: "fake",
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

  it("drops the workspace API key when a per-run selection changes provider", () => {
    const selection: RunModelSelection = {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinking: "enabled",
    };

    expect(
      createModelRuntimeConfig(
        {
          provider: "fake",
          model: "workspace-model",
          thinking: "disabled",
          apiKey: "fake-key",
        },
        selection,
      ),
    ).toMatchObject({
      provider: "deepseek",
      apiKey: undefined,
    });
  });

  it("falls back to workspace model settings when no per-run selection is provided", () => {
    expect(
      createModelRuntimeConfig({
        provider: "fake",
        model: "workspace-model",
        thinking: "disabled",
      }),
    ).toMatchObject({
      provider: "fake",
      model: "workspace-model",
      thinking: "disabled",
    });
  });
});
