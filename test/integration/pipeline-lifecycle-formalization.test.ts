import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { runIdFromRunDirectory } from "../../src/run-terminal-artifacts.ts";
import type {
  RoleTurnHost,
  RoleTurnRequest,
  RoleTurnResult,
} from "../../src/host-contracts.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";

/**
 * #517 §5(c) acceptance: the post-admission lifecycle is host-neutral. A faux
 * RoleTurnHost is injected from the composition root with no Pi dependency; the
 * same external oracle — typed terminal, run-state ledger, real artifact — proves
 * stages ①②④⑤ are still borne by AK, not by the substituted host.
 */
test("acceptance c: host replacement with faux RoleTurnHost through composition root (no Pi dependency)", async () => {
  return await withTempRoot("ak-faux-host-test-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: project });
    execFileSync("git", ["config", "user.email", "cli@test.local"], { cwd: project });
    execFileSync("git", ["config", "user.name", "CLI Test"], { cwd: project });
    execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: project });

    let fauxHostCalled = false;
    let receivedRequest: RoleTurnRequest | undefined;

    const fauxHost: RoleTurnHost = {
      async executeTurn(request: RoleTurnRequest): Promise<RoleTurnResult> {
        fauxHostCalled = true;
        receivedRequest = request;
        // #836: settlement no longer invents an "output failure" artifact for
        // an empty ledger (that would be a runtime-fabricated status) — a real
        // artifact requires a real accepted submission on the ledger, so the
        // faux host seals one through the same production submission-ledger
        // producer any other substituted host would drive.
        const runId = runIdFromRunDirectory(request.runDirectory);
        if (runId === undefined) throw new Error("faux host requires an admitted run directory");
        // Settlement reads the real session transcript to detect a lawful
        // activation happened at all; the submission ledger (sealed below) is
        // a separate sitian-backed record. A substituted host still owns both.
        const sessionDir = join(request.runDirectory, "session");
        await mkdir(sessionDir, { recursive: true });
        await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
        await sealAcceptedSubmission({
          cwd: request.cwd,
          runId,
          runDirectory: request.runDirectory,
          home: request.home,
          role: "judge",
          details: { judgeStatus: "converged", note: "faux host settled" },
        });
        return {
          code: 0,
          stderr: "faux host stderr output",
          timedOut: false,
        };
      },
    };

    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (t: string) => { stdout.push(t); },
      stderr: (t: string) => { stderr.push(t); },
    };

    const result = await runAkRole(
      ["judge", "--project", project, "arbitrate issue #517"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        roleTurnHost: fauxHost,
        io,
      },
    );

    // ①+④: AK still owns admission and dispatch through the injected host.
    assert.equal(fauxHostCalled, true, "faux RoleTurnHost must be invoked by composition root");
    assert.equal(receivedRequest?.activation.role, "judge", "faux host must receive typed judge turn request");
    assert.ok(receivedRequest?.runDirectory, "typed request must carry the AK-issued run directory");

    // ⑤: AK still owns settlement — a typed judge terminal is produced.
    assert.ok(result.terminal, "judge run must settle a typed terminal");
    assert.equal(result.terminal!.roleOutcome.role, "judge");

    // ②: AK-owned run-state ledger reaches terminal regardless of the substituted host.
    const bookKey = resolveBookKeyFromGit(project);
    const runsRoot = join(home, ".ak-roles", "books", bookKey, "runs");
    const runDirs = await readdir(runsRoot);
    const judgeRun = runDirs.find((name) => name.endsWith("@judge"));
    assert.ok(judgeRun, `expected judge run under ${runsRoot}, got ${runDirs.join(", ")}`);
    const runDirectory = join(runsRoot, judgeRun!);
    const runState = JSON.parse(
      await readFile(join(runDirectory, "run-state.json"), "utf8"),
    ) as { state: string };
    assert.equal(runState.state, "terminal", "AK-owned run-state must settle as terminal");

    // A real artifact is produced by AK settlement for the terminal. Open the
    // exact typed artifact ref — not just assert path is a string — and confirm
    // it is not a dangling ref by reading minimal structured role/outcome.
    const artifact = result.terminal!.artifacts[0];
    assert.ok(artifact, "settled terminal must publish at least one real artifact");
    const artifactBody = JSON.parse(
      await readFile(artifact.path, "utf8"),
    ) as { role?: string; outcome?: { kind?: string; payloads?: readonly unknown[] } };
    assert.equal(artifactBody.role, "judge", "artifact must carry the judge role");
    assert.equal(artifactBody.outcome?.kind, "accepted", "artifact must carry the accepted outcome kind");
    // #836: the published artifact carries the role's own original payload —
    // not a runtime-invented status.
    assert.equal(
      (artifactBody.outcome?.payloads?.at(-1) as { judgeStatus?: string } | undefined)?.judgeStatus,
      "converged",
    );
    });
});
