import { vi } from "vitest";
import { roleRuntimeDependenciesWithoutNavigator } from "./role-turn-host-fixture.ts";

// Keep the default adapter table and real production factories. These source
// tests must use the same dependency seam even when a local dist build exists;
// the packaged bundle itself is exercised by the package tests.
vi.mock("../../dist/acp-host/production-host.js", () => import("../../src/acp-host/production-host.ts"));
vi.mock("../../dist/headless-host/production-host.js", () => import("../../src/headless-host/production-host.ts"));

vi.mock("../../src/role-runtime-dependencies.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/role-runtime-dependencies.ts")>();
  return {
    ...actual,
    createRoleRuntimeDependencies: (root: string) =>
      roleRuntimeDependenciesWithoutNavigator(root, actual.createRoleRuntimeDependencies),
  };
});
