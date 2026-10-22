import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Expand phase (ADR 0090): these lists are the migrated set. scripts/run-test-all.mjs
// runs every other integration/package file under node:test; #1250 restores the globs.
const integrationMigrated = [
  "test/integration/acp-unknown-client-request.test.ts",
  "test/adjudication/activation-bare-seam.test.ts",
  "test/integration/analyst-c1-sweep-index.test.ts",
  "test/integration/analyst-c1-sweep-pages.test.ts",
  "test/integration/analyst-c2-cohort.test.ts",
  "test/integration/analyst-c3-model-groups.test.ts",
  "test/integration/analyst-c4-ticket-scope.test.ts",
  "test/integration/analyst-compute-if-missing.test.ts",
  "test/integration/analyst-entry.test.ts",
  "test/integration/countersign-notary-gate.test.ts",
  "test/integration/dossier-resolution.test.ts",
  "test/integration/engine-detour-usage-ledger.test.ts",
  "test/integration/engine-material.test.ts",
  "test/integration/factory-board.test.ts",
  "test/integration/headless-codex-host.test.ts",
  "test/integration/host-session-acp-grok-usage-compact.test.ts",
  "test/integration/host-session-acp-write-fail.test.ts",
  "test/integration/host-session-live-records.test.ts",
  "test/integration/package-home-cli-seam.test.ts",
  "test/integration/pipeline-lifecycle-formalization.test.ts",
  "test/integration/public-cli-1132-delivery-request.test.ts",
  "test/integration/public-cli-1169-relocate-resume-no-unbound-paths.test.ts",
  "test/integration/public-cli-argv-parsers.test.ts",
  "test/integration/public-cli-attach-path-passthrough.test.ts",
  "test/integration/public-cli-auto-resume-dispatch-throw.test.ts",
  "test/integration/public-cli-auto-resume-limit-422.test.ts",
  "test/integration/public-cli-bin-startup.test.ts",
  "test/integration/public-cli-cli.test.ts",
  "test/integration/public-cli-coder.test.ts",
  "test/integration/public-cli-collector.test.ts",
  "test/integration/public-cli-config.test.ts",
  "test/integration/public-cli-countersign-run.test.ts",
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
