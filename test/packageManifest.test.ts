import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));

describe("package manifest", () => {
  it("requires the VS Code Node 22 sqlite baseline", () => {
    expect(manifest.engines.vscode).toBe("^1.103.0");
    expect(manifest.devDependencies["@types/vscode"]).toBe("^1.103.0");
    expect(manifest.contributes.configuration.properties["loopagent.model.thinking"].default).toBe("enabled");
  });

  it("excludes integration probes from production VSIX", () => {
    expect(manifest.scripts["vscode:prepublish"]).toBe("npm run compile -- --production");

    const vscodeIgnoreLines = readFileSync(resolve(process.cwd(), ".vscodeignore"), "utf8").split(
      /\r?\n/,
    );
    expect(vscodeIgnoreLines).toContain("dist/test/**");
  });

  it("contributes LoopAgent as a side bar chat view instead of an editor tab command", () => {
    expect(manifest.activationEvents).toContain("onView:loopagent.chat");
    expect(manifest.activationEvents).toContain("onCommand:loopagent.focusChat");
    expect(manifest.activationEvents).not.toContain("onCommand:loopagent.openPanel");

    expect(manifest.contributes.commands).toContainEqual({
      command: "loopagent.focusChat",
      title: "LoopAgent: Focus Chat",
    });
    expect(manifest.contributes.commands).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "loopagent.openPanel" })]),
    );

    expect(manifest.contributes.viewsContainers.secondarySidebar).toContainEqual({
      id: "loopagent",
      title: "LoopAgent",
      icon: "resources/loopagent.svg",
    });
    expect(manifest.contributes.viewsContainers.activitybar).toBeUndefined();
    expect(manifest.contributes.views.loopagent).toContainEqual({
      id: "loopagent.chat",
      name: "Chat",
      type: "webview",
    });
  });

  it("shows accept and discard actions only on LoopAgent edit previews", () => {
    expect(manifest.contributes.commands).toEqual(expect.arrayContaining([
      { command: "loopagent.acceptEditReview", title: "接受全部", icon: "$(check)" },
      { command: "loopagent.discardEditReview", title: "放弃", icon: "$(close)" },
    ]));
    expect(manifest.contributes.menus["editor/title"]).toEqual(expect.arrayContaining([
      {
        command: "loopagent.acceptEditReview",
        when: "resourceScheme == loopagent-edit-preview",
        group: "navigation@1",
      },
      {
        command: "loopagent.discardEditReview",
        when: "resourceScheme == loopagent-edit-preview",
        group: "navigation@2",
      },
    ]));
  });
});
