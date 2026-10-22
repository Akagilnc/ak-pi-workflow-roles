import { globSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import { importsNodeTest } from "./scripts/node-test-batch.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const nodeTestFiles = globSync("test/**/*.test.ts", { cwd: root })
  .filter((file) => importsNodeTest(join(root, file)));
const exclude = [...configDefaults.exclude, ...nodeTestFiles];

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
          exclude,
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts", "test/adjudication/**/*.test.ts"],
          exclude,
        },
      },
      {
        test: {
          name: "package",
          include: ["test/package/**/*.test.ts"],
          exclude,
        },
      },
    ],
  },
});
