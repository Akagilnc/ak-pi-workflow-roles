/**
 * #420: Fixer production activation args reach the real Pi loader for both
 * optional methods. #526: uses host turn seam + test materialization helper.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority, decodePiDurablePrincipal } from "../../src/pi/durable-principal.ts";
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
        sessionFile: decodePiDurablePrincipal(piDurablePrincipalAuthority, applyAdmitted.principal).sessionFile,
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
        sessionFile: decodePiDurablePrincipal(piDurablePrincipalAuthority, applyAdmitted.principal).sessionFile,
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
