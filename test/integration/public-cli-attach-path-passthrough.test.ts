/**
 * #1165: --attach and collector --request-manifest pass caller paths as-is.
 * Seam: ak-role public entry + in-repo fake host; assert structured admitted
 * input and run-directory shape only (no generated-prompt prose locks).
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { COLLECTOR_OUTPUT_TOOL } from "../../src/package-contracts/collector-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";

function sessionToolResultLine(toolName: string, details: unknown): string {
  return `${JSON.stringify({
    type: "message",
    message: {
      role: "toolResult",
      toolName,
      isError: false,
      details,
    },
  })}\n`;
}

function collectorReceipt() {
  return {
    host: "github.com",
    repository: "acme/widgets",
    prNumber: 42,
    prState: "OPEN",
    manifestDigest: "unused-by-path-only",
    groups: [],
    unfinishedReasons: [],
  };
}

test("#1165 --attach passes opaque path as-is; whitespace instruction retained; missing file still runs", async () => {
  await withTempRoot("ak-attach-passthrough-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const relativeAttach = "notes/rel-evidence.md";
    await mkdir(join(project, "notes"), { recursive: true });
    await writeFile(join(project, relativeAttach), "evidence-v1", "utf8");
    const spaceAttach = " ";
    await writeFile(join(project, spaceAttach), "space-name", "utf8");
    const emptyAttach = "";
    const missingAttach = "notes/does-not-exist.md";
    // Whitespace-only dispatch must remain on the admitted page (#1165 J3).
    const instruction = " \n\t";

    const { io } = captureIo();
    const result = await runAkRole([
      "judge",
      "--model", "test/caller-seat:high",
      "--project", project,
      "--attach", relativeAttach,
      "--attach", spaceAttach,
      "--attach", emptyAttach,
      "--attach", missingAttach,
      instruction,
    ], {
      packageRoot,
      home,
      cwd: project,
      createRunId: () => "run-attach-passthrough-001",
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args) => {
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await writeFile(
            sessionFile,
            sessionToolResultLine(JUDGE_OUTPUT_TOOL_NAME, {
              status: "converged",
              findings: [],
              reason: "ok",
            }),
          );
          return { code: 0, timedOut: false, stderr: "", args: [...args] };
        },
      }),
    });

    assert.equal(result.exitCode, 0);
    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home, ".ak-roles", "books", bookKey, "unbound", "runs",
      "run-attach-passthrough-001@judge",
    );
    assert.equal(existsSync(join(runDirectory, "attachments")), false);

    const current = JSON.parse(await readFile(join(runDirectory, "current.json"), "utf8")) as {
      admitted: {
        instruction: string;
        instructionEmpty: boolean;
        attachments: Array<Record<string, unknown>>;
      };
    };
    assert.equal(current.admitted.instruction, instruction);
    assert.equal(current.admitted.instructionEmpty, false);
    assert.deepEqual(
      current.admitted.attachments.map((a) => a.path),
      [relativeAttach, spaceAttach, emptyAttach, missingAttach],
    );
    for (const attachment of current.admitted.attachments) {
      assert.equal("frozenPath" in attachment, false);
      assert.equal("sha256" in attachment, false);
      assert.equal("byteLength" in attachment, false);
      assert.equal("provenancePath" in attachment, false);
    }
  });
});

test("#1165 --request-manifest/--attach keep opaque values; host flag wires path; cwd may differ", async () => {
  await withTempRoot("ak-request-manifest-passthrough-", async (home) => {
    const project = join(home, "project");
    const callerCwd = join(home, "caller-cwd");
    await mkdir(project, { recursive: true });
    await mkdir(callerCwd, { recursive: true });
    seedGitProject(project);

    const samePath = join(home, "reqs", "same.json");
    await mkdir(join(home, "reqs"), { recursive: true });
    await writeFile(samePath, "{ not json", "utf8");
    const spaceManifest = " ";
    await writeFile(join(callerCwd, spaceManifest), "{}", "utf8");
    const instruction = "collect unchanged";

    for (const [label, argvExtra, runId, expectManifest] of [
      [
        "mixed-same-path",
        ["--attach", samePath, "--request-manifest", samePath],
        "run-manifest-mixed-001",
        samePath,
      ],
      [
        "space-manifest",
        ["--request-manifest", spaceManifest],
        "run-manifest-space-001",
        spaceManifest,
      ],
      [
        "missing-manifest",
        ["--request-manifest", join(home, "reqs", "does-not-exist.json")],
        "run-manifest-missing-001",
        join(home, "reqs", "does-not-exist.json"),
      ],
      [
        "empty-string-manifest",
        ["--request-manifest", ""],
        "run-manifest-empty-001",
        "",
      ],
    ] as const) {
      let capturedArgs: string[] | undefined;
      const { io } = captureIo();
      const result = await runAkRole([
        "collector",
        "--model", "test/caller-seat:high",
        "--pr", "42",
        "--repo", "acme/widgets",
        "--project", project,
        ...argvExtra,
        instruction,
      ], {
        packageRoot,
        home,
        // Caller process cwd ≠ project; host may also differ — pass absolute path.
        cwd: callerCwd,
        createRunId: () => runId,
        io,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args) => {
            capturedArgs = [...args];
            const sessionFile = args[args.indexOf("--session") + 1]!;
            await writeFile(
              sessionFile,
              sessionToolResultLine(COLLECTOR_OUTPUT_TOOL, collectorReceipt()),
            );
            return {
              code: 0,
              timedOut: false,
              stderr: "",
              args: [...args],
              sealedAcceptance: { role: "collector" as const, details: collectorReceipt() },
            };
          },
        }),
      });

      assert.equal(result.exitCode, 0, `${label} must still start`);
      const bookKey = resolveBookKeyFromGit(project);
      const runDirectory = join(
        home, ".ak-roles", "books", bookKey, "unbound", "runs",
        `${runId}@collector`,
      );
      await assert.rejects(
        () => access(join(runDirectory, "request-manifest.json")),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
      );

      const current = JSON.parse(await readFile(join(runDirectory, "current.json"), "utf8")) as {
        admitted: {
          instruction: string;
          requestManifestPath?: string;
          attachments?: Array<{ path: string }>;
          manifestDigest?: string;
        };
      };
      assert.equal(current.admitted.instruction, instruction);
      assert.equal(current.admitted.requestManifestPath, expectManifest);
      assert.equal("manifestDigest" in current.admitted, false);

      if (label === "mixed-same-path") {
        assert.deepEqual(
          current.admitted.attachments?.map((a) => a.path),
          [samePath],
        );
      }

      // Structured host-flag contract (external argv), not generated prompt prose.
      const flagIndex = capturedArgs?.indexOf("--ak-collector-request-manifest") ?? -1;
      assert.ok(flagIndex >= 0);
      assert.equal(capturedArgs?.[flagIndex + 1], expectManifest);
    }
  });
});
