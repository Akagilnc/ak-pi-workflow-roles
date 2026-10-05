/**
 * #1165: --attach and collector --request-manifest pass caller paths as-is.
 * Seam: ak-role public entry + in-repo fake host; assert structured admitted
 * input, first-message path delivery, and run-directory shape.
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
import { readUserDialogueStdin } from "../../src/user-dialogue-stdin.ts";
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

test("#1165 --attach passes caller path as-is; no attachments/ copy; missing file still runs", async () => {
  await withTempRoot("ak-attach-passthrough-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const relativeAttach = "notes/rel-evidence.md";
    await mkdir(join(project, "notes"), { recursive: true });
    await writeFile(join(project, relativeAttach), "evidence-v1", "utf8");
    const missingAttach = "notes/does-not-exist.md";
    const instruction = "review the attached paths";

    let capturedStdin: string | undefined;
    const { io } = captureIo();
    const result = await runAkRole([
      "judge",
      "--model", "test/caller-seat:high",
      "--project", project,
      "--attach", relativeAttach,
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
        piRunner: async (args, options) => {
          capturedStdin = options?.stdin;
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
        attachments: Array<Record<string, unknown>>;
      };
    };
    assert.equal(current.admitted.instruction, instruction);
    assert.deepEqual(
      current.admitted.attachments.map((a) => a.path),
      [relativeAttach, missingAttach],
    );
    for (const attachment of current.admitted.attachments) {
      assert.equal("frozenPath" in attachment, false);
      assert.equal("sha256" in attachment, false);
      assert.equal("byteLength" in attachment, false);
      assert.equal("provenancePath" in attachment, false);
    }

    const delivered = readUserDialogueStdin(capturedStdin ?? "");
    assert.ok(delivered.startsWith(instruction));
    assert.ok(delivered.includes(relativeAttach));
    assert.ok(delivered.includes(missingAttach));
    assert.equal(delivered.includes(join(project, relativeAttach)), false);
    assert.equal(delivered.includes(join(runDirectory, "attachments")), false);
  });
});

test("#1165 diarist admit keeps caller attach path for secretariat handoff", async () => {
  const { admitPublicRole, parsePublicSeatArgv } = await import("../../src/public-cli/invocation.ts");
  await withTempRoot("ak-secretariat-attach-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const relativeAttach = "notes/sec-attach.md";
    await mkdir(join(project, "notes"), { recursive: true });
    await writeFile(join(project, relativeAttach), "sec material", "utf8");

    const admitted = await admitPublicRole(
      "diarist",
      parsePublicSeatArgv("diarist", [
        "--project", project,
        "--attach", relativeAttach,
        "请辨认并建立本票。",
      ]),
      {
        home,
        principalAuthority: piDurablePrincipalAuthority,
        cwd: project,
        createRunId: () => "run-sec-attach-diarist",
      },
    );
    assert.deepEqual(
      admitted.attachments.map((attachment) => attachment.path),
      [relativeAttach],
    );
    assert.equal(existsSync(join(admitted.runDirectory, "attachments")), false);
  });
});

test("#1165 --request-manifest passes caller path; missing/bad file still runs; no rewrite copy", async () => {
  await withTempRoot("ak-request-manifest-passthrough-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const relativeManifest = "reqs/caller-manifest.json";
    await mkdir(join(project, "reqs"), { recursive: true });
    await writeFile(join(project, relativeManifest), "{ not json", "utf8");
    const instruction = "collect with named requests";

    let capturedStdin: string | undefined;
    let capturedArgs: string[] | undefined;
    const { io } = captureIo();
    const result = await runAkRole([
      "collector",
      "--model", "test/caller-seat:high",
      "--pr", "42",
      "--repo", "acme/widgets",
      "--project", project,
      "--request-manifest", relativeManifest,
      instruction,
    ], {
      packageRoot,
      home,
      cwd: project,
      createRunId: () => "run-manifest-passthrough-001",
      io,
      roleTurnHost: roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args, options) => {
          capturedStdin = options?.stdin;
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

    assert.equal(result.exitCode, 0);
    const bookKey = resolveBookKeyFromGit(project);
    const runDirectory = join(
      home, ".ak-roles", "books", bookKey, "unbound", "runs",
      "run-manifest-passthrough-001@collector",
    );
    await assert.rejects(
      () => access(join(runDirectory, "request-manifest.json")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );

    const current = JSON.parse(await readFile(join(runDirectory, "current.json"), "utf8")) as {
      admitted: {
        instruction: string;
        requestManifestPath?: string;
      };
    };
    assert.equal(current.admitted.instruction, instruction);
    assert.equal(current.admitted.requestManifestPath, relativeManifest);

    const delivered = readUserDialogueStdin(capturedStdin ?? "");
    assert.ok(delivered.startsWith(instruction));
    assert.ok(delivered.includes(relativeManifest));
    assert.equal(delivered.includes("{ not json"), false);

    const flagIndex = capturedArgs?.indexOf("--ak-collector-request-manifest") ?? -1;
    assert.ok(flagIndex >= 0);
    assert.equal(capturedArgs?.[flagIndex + 1], relativeManifest);
  });
});
