import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Expand phase (ADR 0090): these lists are the migrated set. scripts/run-test-all.mjs
// runs every other integration/package file under node:test; #1250 restores the globs.
const integrationMigrated = [
  "test/integration/acp-unknown-client-request.test.ts",
  "test/adjudication/activation-bare-seam.test.ts",
  "test/integration/factory-board.test.ts",
  "test/integration/public-cli-bin-startup.test.ts",
  "test/integration/test-user-profile-preload.test.ts",
];
const packageMigrated = [
  "test/package/published-dist-import-closure.test.ts",
];

export default defineConfig({
  test: {
    testTimeout: 300_000,
    execArgv: ["--import", fileURLToPath(new URL("./scripts/vitest-worker-preload.mjs", import.meta.url))],
    setupFiles: ["./test/setup.ts"],
    reporters: ["dot", "json"],
    outputFile: { json: ".vitest/results.json" },
    projects: [
      {
        test: {
          name: "unit-contract",
          include: ["test/unit/**/*.test.ts", "test/contract/**/*.test.ts", "test/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: integrationMigrated,
        },
      },
      {
        test: {
          name: "package",
          include: packageMigrated,
        },
      },
    ],
  },
});
