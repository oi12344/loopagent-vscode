import { describe, expect, it } from "vitest";

import type { ImportBinding } from "../../src/extension/intelligence/graph/graphTypes";
import { resolveImportBindings } from "../../src/extension/intelligence/resolution/modulePathResolver";

function binding(
  filePath: string,
  source: string,
  importedName: string,
  languageId = "typescript",
): ImportBinding {
  return {
    filePath,
    source,
    importedName,
    localName: importedName,
    languageId,
  };
}

describe("resolveImportBindings", () => {
  it("resolves TypeScript relative files and index modules", () => {
    const resolved = resolveImportBindings(
      [
        binding("src/model/provider.ts", "./runner", "createRunner"),
        binding("src/feature/useApi.ts", "../api", "request"),
      ],
      ["src/model/provider.ts", "src/model/runner.ts", "src/api/index.ts"],
    );

    expect(resolved[0]?.resolvedFilePath).toBe("src/model/runner.ts");
    expect(resolved[1]?.resolvedFilePath).toBe("src/api/index.ts");
  });

  it("resolves Python modules and package initializers", () => {
    const resolved = resolveImportBindings(
      [
        binding("app/service.py", ".repo", "load_user", "python"),
        binding("app/service.py", "app.client", "Client", "python"),
      ],
      ["app/service.py", "app/repo.py", "app/client/__init__.py"],
    );

    expect(resolved[0]?.resolvedFilePath).toBe("app/repo.py");
    expect(resolved[1]?.resolvedFilePath).toBe("app/client/__init__.py");
  });

  it("returns copied unresolved bindings without mutating cached extraction results", () => {
    const original = binding("src/a.ts", "external-package", "run");

    const [resolved] = resolveImportBindings([original], ["src/a.ts"]);

    expect(resolved).toEqual(original);
    expect(resolved).not.toBe(original);
  });
});
