/**
 * #420: Fixer production activation args reach the real Pi loader for both
 * optional methods. #526: uses host turn seam + test materialization helper.
 */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { createPiRoleTurnHost } from "../../src/pi/role-turn-host.ts";
import { buildFixerTurnRequest } from "../../src/public-cli/fixer-run.ts";
import { admitFixerInvocation, buildFixerTransportPrompt } from "../../src/public-cli/invocation.ts";
import { engineSessionMaterialFromOptions } from "../../src/package-resources/engine-material.ts";
import { selectResumeContinuationPrompt } from "../../src/public-cli/run-lifecycle.ts";
import {
  packageRoot,
  runPiSubprocess,
  withActivationHome,
} from "../helpers/pi-test-harness.ts";

test("Fixer production activation args reach the real Pi loader for both optional methods", async () => {
  await withActivationHome({ prefix: "ak-fixer-method-trace-" }, async ({ home, agentDir }) => {
    const applyAdmitted = await admitFixerInvocation({
      principalAuthority: piDurablePrincipalAuthority,
      home,
      cwd: home,
      phase: "apply",
      instruction: "Apply the approved repair.",
      attachmentPaths: [],
      createRunId: () => "run-fixer-method-trace-apply",
    });
    const rows = [
      {
        name: "initial-apply",
        request: buildFixerTurnRequest(applyAdmitted, {
          packageRoot,
          home,
          agentDir,
          continuation: {
            kind: "initial",
            prompt: buildFixerTransportPrompt(
              applyAdmitted,
              engineSessionMaterialFromOptions({ packageRoot }),
            ),
          },
        }),
        sessionFile: piDurablePrincipalAuthority.decode(applyAdmitted.principal).sessionFile,
      },
      {
        name: "resume-apply",
        request: buildFixerTurnRequest(applyAdmitted, {
          packageRoot,
          home,
          agentDir,
          continuation: {
            kind: "resume",
            prompt: selectResumeContinuationPrompt(),
          },
        }),
        sessionFile: piDurablePrincipalAuthority.decode(applyAdmitted.principal).sessionFile,
      },
    ];
    for (const row of rows) {
      const host = createPiRoleTurnHost({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        extraPiArgs: [
          "-e",
          join(packageRoot, "test", "fixtures", "fixer-dual-skill-availability-provider.ts"),
          "--provider",
          "ak-fixer-dual-skill-availability",
          "--model",
          "faux-1",
        ],
        spawnRunner: async (args, options) => {
          const subprocess = await runPiSubprocess(
            [
              ...args,
              "--mode",
              "print",
              "--print",
              "/skill:diagnosing-bugs inspect the root cause",
              "--print",
              "/skill:tdd verify the repair",
            ],
            {
              cwd: options.cwd,
              env: options.env,
            },
          );
          return {
            code: subprocess.code,
            stderr: subprocess.stderr,
            timedOut: subprocess.localTimeout,
          };
        },
      });
      const result = await host.executeTurn(row.request);
      assert.equal(result.code, 0, `${row.name}: ${result.stderr}`);
      const sessionText = await readFile(row.sessionFile, "utf8");
      const userTexts = sessionText
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map(
          (line) =>
            JSON.parse(line) as {
              message?: {
                role?: string;
                content?: Array<{ type?: string; text?: string }>;
              };
            },
        )
        .filter((entry) => entry.message?.role === "user")
        .map(
          (entry) =>
            entry.message?.content
              ?.filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join("\n") ?? "",
        );
      assert.equal(userTexts.some((text) => text.includes('<skill name="diagnosing-bugs"')), true, row.name);
      assert.equal(userTexts.some((text) => text.includes('<skill name="tdd"')), true, row.name);
      assert.equal(userTexts[0]?.includes("<skill name="), false, row.name);
    }
  });
});

test(
  "Pi resume prior native records reach the session user message via stdin",
  { timeout: 120_000 },
  async () => {
    await withActivationHome({ prefix: "ak-pi-prior-stdin-" }, async ({ home, agentDir }) => {
      const principal = piDurablePrincipalAuthority.issue({
        cwd: home,
        runId: "run-pi-prior-stdin",
        role: "judge",
        home,
      });
      const coords = piDurablePrincipalAuthority.decode(principal);
      await mkdir(coords.sessionDirectory, { recursive: true });
      const host = createPiRoleTurnHost({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        extraPiArgs: [
          "-e",
          join(packageRoot, "test", "fixtures", "fixer-dual-skill-availability-provider.ts"),
          "--provider",
          "ak-fixer-dual-skill-availability",
          "--model",
          "faux-1",
        ],
      });
      const prior = '{"grokStructuredId":"seed-grok-1"}\n';
      const prompt = "resume-now";
      const result = await host.executeTurn({
        principal,
        activation: { role: "judge" },
        methods: [],
        continuation: { kind: "resume", prompt },
        cwd: home,
        home,
        agentDir,
        runDirectory: dirname(coords.sessionDirectory),
        hostTransition: { previousHost: "grok-build", priorNativeRecords: prior },
      });
      assert.equal(result.code, 0, result.stderr);
      const sessionText = await readFile(coords.sessionFile, "utf8");
      const userTexts = sessionText
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map(
          (line) =>
            JSON.parse(line) as {
              message?: {
                role?: string;
                content?: Array<{ type?: string; text?: string }>;
              };
            },
        )
        .filter((entry) => entry.message?.role === "user")
        .map(
          (entry) =>
            entry.message?.content
              ?.filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join("\n") ?? "",
        );
      const consumed = userTexts.find((text) => text.includes("grokStructuredId"));
      assert.ok(consumed, sessionText);
      assert.equal(consumed.includes("seed-grok-1"), true);
      assert.equal(consumed.includes("resume-now"), true);
      assert.equal(consumed.includes("}resume-now"), false);
    });
  },
);
