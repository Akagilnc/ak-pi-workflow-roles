import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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
          include: ["test/integration/**/*.test.ts", "test/adjudication/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "package",
          include: ["test/package/**/*.test.ts"],
        },
      },
    ],
  },
});
