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
import { loadAdmittedJudgeRequest } from "../../src/public-cli/invocation.ts";
import { readUserDialogueStdin } from "../../src/user-dialogue-stdin.ts";
import {
  rewriteAdmittedRoleRunPage,
  rewriteRoleRunDurablePages,
} from "../../src/role-run-relocation.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { roleTurnHostFromLegacyPiRunner } from "../helpers/role-turn-host-fixture.ts";
import { seedCurrentSection } from "../helpers/run-dossier-fixture.ts";

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

test("#1165 --request-manifest: malformed existing and missing both start; cwd may differ from project", async () => {
  await withTempRoot("ak-request-manifest-passthrough-", async (home) => {
    const project = join(home, "project");
    const callerCwd = join(home, "caller-cwd");
    await mkdir(project, { recursive: true });
    await mkdir(callerCwd, { recursive: true });
    seedGitProject(project);

    const badManifest = join(home, "reqs", "caller-manifest.json");
    await mkdir(join(home, "reqs"), { recursive: true });
    await writeFile(badManifest, "{ not json", "utf8");
    const missingManifest = join(home, "reqs", "does-not-exist.json");
    const instruction = "collect with named requests";

    for (const [label, manifestPath, runId] of [
      ["bad", badManifest, "run-manifest-bad-001"],
      ["missing", missingManifest, "run-manifest-missing-001"],
    ] as const) {
      let capturedStdin: string | undefined;
      let capturedArgs: string[] | undefined;
      const { io } = captureIo();
      const result = await runAkRole([
        "collector",
        "--model", "test/caller-seat:high",
        "--pr", "42",
        "--repo", "acme/widgets",
        "--project", project,
        "--request-manifest", manifestPath,
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

      assert.equal(result.exitCode, 0, `${label} manifest must still start`);
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
        };
      };
      assert.equal(current.admitted.instruction, instruction);
      assert.equal(current.admitted.requestManifestPath, manifestPath);

      const delivered = readUserDialogueStdin(capturedStdin ?? "");
      assert.ok(delivered.startsWith(instruction));
      assert.ok(delivered.includes(manifestPath));
      assert.equal(delivered.includes("{ not json"), false);

      const flagIndex = capturedArgs?.indexOf("--ak-collector-request-manifest") ?? -1;
      assert.ok(flagIndex >= 0);
      assert.equal(capturedArgs?.[flagIndex + 1], manifestPath);
    }
  });
});

test("#1165 relocation leaves caller attach/manifest paths even when they sit under the old run dir", async () => {
  await withTempRoot("ak-attach-reloc-", async (home) => {
    const oldRunDirectory = join(home, "books", "proj", "unbound", "runs", "r@collector");
    const newRunDirectory = join(home, "books", "proj", "1165", "runs", "r@collector");
    const callerAttach = join(oldRunDirectory, "caller-note.md");
    const callerManifest = join(oldRunDirectory, "caller-manifest.json");

    const admittedPage: Record<string, unknown> = {
      runDirectory: oldRunDirectory,
      sessionDirectory: join(oldRunDirectory, "session"),
      requestManifestPath: callerManifest,
      attachments: [{ path: callerAttach }],
    };
    rewriteAdmittedRoleRunPage(admittedPage, [
      { oldRunDirectory, newRunDirectory },
    ]);
    assert.equal(admittedPage.runDirectory, newRunDirectory);
    assert.equal(admittedPage.sessionDirectory, join(newRunDirectory, "session"));
    assert.equal(admittedPage.requestManifestPath, callerManifest);
    assert.deepEqual(admittedPage.attachments, [{ path: callerAttach }]);

    // Pre-#1161 page file path: rewriter updates bytes without Sitian append.
    await mkdir(oldRunDirectory, { recursive: true });
    await writeFile(
      join(oldRunDirectory, "run-state.json"),
      `${JSON.stringify({
        runDirectory: oldRunDirectory,
        currentCourt: {
          summons: {
            instruction: "resume with attach",
            attachmentPaths: [callerAttach],
            sourceRunPath: oldRunDirectory,
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await rewriteRoleRunDurablePages({
      pagesDirectory: oldRunDirectory,
      oldRunDirectory,
      newRunDirectory,
    });
    const runState = JSON.parse(
      await readFile(join(oldRunDirectory, "run-state.json"), "utf8"),
    ) as {
      currentCourt: { summons: { attachmentPaths: string[]; sourceRunPath: string } };
    };
    assert.deepEqual(
      runState.currentCourt.summons.attachmentPaths,
      [callerAttach],
    );
    assert.equal(
      runState.currentCourt.summons.sourceRunPath,
      newRunDirectory,
    );
  });
});

test("#1165 read seam ignores abolished frozenPath/provenancePath attachment fields", async () => {
  await withTempRoot("ak-attach-legacy-read-", async (home) => {
    const runDirectory = join(home, "run");
    seedCurrentSection(runDirectory, "admitted", {
      role: "judge",
      instruction: "legacy page",
      instructionEmpty: false,
      attachments: [
        {
          frozenPath: join(runDirectory, "attachments", "00-old.md"),
          provenancePath: "/caller/old.md",
          sha256: "deadbeef",
          byteLength: 4,
        },
        { path: "notes/only-path.md" },
      ],
    });
    const loaded = await loadAdmittedJudgeRequest(runDirectory);
    assert.ok(loaded);
    assert.deepEqual(
      loaded.attachments.map((attachment) => attachment.path),
      ["notes/only-path.md"],
    );
  });
});
