/**
 * Minimal child process: boot one in-process Merger with a malformed candidate
 * and let the fatal path set process.exitCode. Used by merger-role.test.ts so
 * the parent does not re-run the whole test file to observe exit 1.
 */
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRoleRuntimeExtension } from "../../src/role-runtime.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "../../src/merger-contracts.ts";
import { sha256Hex } from "../../src/sha256.ts";
import { withHermeticHome, withInProcessPi } from "../helpers/pi-test-harness.ts";

const oid = (c: string) => c.repeat(40);
const mat = (s: string) => ({ bytesBase64: Buffer.from(s).toString("base64"), sha256: sha256Hex(s) });
const input = {
  version: 1 as const,
  attemptId: "attempt",
  targetObjectId: oid("a"),
  sourceObjectId: oid("b"),
  materials: {
    task: mat("task"),
    authority: mat("authority"),
    targetIntent: mat("target intent"),
    sourceIntent: mat("source intent"),
  },
  expectedConflictPaths: ["same.txt"],
  resolutionScope: ["same.txt"],
  authorizedChecks: [{ name: "test", argv: ["npm", "test"] }],
};

const candidate = {
  status: "escalate",
  attemptId: "attempt",
  report: "missing diagnosis",
};

process.exitCode = 0;
await withHermeticHome({ prefix: "ak-merger-fatal-child-" }, async ({ home, agentDir }) => {
  const faux = fauxProvider({ api: "merger-fatal-child", provider: "merger-fatal-child" });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(MERGER_OUTPUT_TOOL_NAME, candidate, { id: "out" }), {
      stopReason: "toolUse",
    }),
  ]);
  await withInProcessPi(
    {
      cwd: home,
      agentDir,
      faux,
      modelsPath: null,
      noExtensions: true,
      systemPrompt: "MERGER",
      mode: "print",
      flags: { "ak-role": "merger", "ak-merger-input": "/input.json" },
      extensionFactories: [
        createRoleRuntimeExtension({
          loadJudgeSoul: async () => "unused",
          transcriptFromContext: () => "unused",
          auditSoulCompliance: async () => ({ status: "pass", violations: [] }),
          loadMergerSoul: async () => "MERGER LAW",
          loadMergerInput: async () => input,
          mergerGitState: {
            activeMerge: async () => ({
              targetObjectId: oid("a"),
              sourceObjectId: oid("b"),
              unmergedPaths: ["same.txt"],
              automaticMergeTreeId: oid("d"),
            }),
            completedMerge: async () => {
              throw new Error("unused");
            },
          },
        }),
      ],
    },
    async ({ session }) => {
      await session.prompt("Settle.");
    },
  );
});
process.exit(process.exitCode ?? 0);
