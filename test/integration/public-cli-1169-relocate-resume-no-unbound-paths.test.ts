/**
 * #1169 through-line: public `ak-role` + fake host.
 * Fixer with --attach/--prerequisites + engine lands in unbound/, relocates to
 * ticket, inspector is summoned, fixer resumes. Package-added first-message /
 * startup-material surfaces (excluding caller file-flag paths and the audited
 * peer body) must not contain the original unbound run-directory prefix.
 * Relocated leg top-level shape matches docs/dossier-topology.md.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import type { RoleTurnHost } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { runIdFromRunDirectory } from "../../src/run-terminal-artifacts.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import {
  configurePassingReviewSeats,
  seedPublicSeat,
} from "../helpers/passing-review-host.ts";
import { packageRoot, withHermeticHome } from "../helpers/pi-test-harness.ts";
import {
  capturePreparedEnvelope,
  createMinimalHost,
  sessionToolExchangeRows,
  writeSessionJsonl,
} from "../helpers/role-turn-host-fixture.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";

const ENGINE = "cursor";
const ENGINE_MODEL = "cursor-grok-4.6-high";
const SEAT = "test/caller-seat:high";
const TICKET = 1169;
const DISPATCH = "Repair the class under review.";
const CREDS = { "openai-codex": true, xai: true } as const;

type Captured = Awaited<ReturnType<typeof capturePreparedEnvelope>>;

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
}

/** Package-added surfaces after stripping caller file-flag paths and peer body. */
function packageAddedText(
  prompt: string,
  materials: readonly unknown[],
  excludeExact: readonly string[],
): string {
  const parts: string[] = [prompt];
  collectStrings(materials, parts);
  let text = parts.join("\n");
  for (const exact of excludeExact) {
    if (exact.length === 0) continue;
    text = text.split(exact).join("");
  }
  return text;
}

function assertNoUnboundPrefix(
  label: string,
  prompt: string,
  materials: readonly unknown[],
  unboundRunDirectory: string,
  excludeExact: readonly string[],
): void {
  const text = packageAddedText(prompt, materials, excludeExact);
  assert.equal(
    text.includes(unboundRunDirectory),
    false,
    `${label}: package-added surfaces must not contain unbound run directory ${unboundRunDirectory}`,
  );
}

async function sealTerminatingTurn(input: {
  readonly request: Parameters<RoleTurnHost["executeTurn"]>[0];
  readonly role: "fixer" | "inspector";
  readonly toolName: string;
  readonly details: unknown;
  readonly toolCallId: string;
}): Promise<void> {
  const coords = piDurablePrincipalAuthority.decode(input.request.principal);
  await writeSessionJsonl(
    coords.sessionFile,
    sessionToolExchangeRows({
      stem: "1",
      parentId: "user-1",
      callId: input.toolCallId,
      toolName: input.toolName,
      details: input.details,
      body: `${input.role} output accepted`,
      isError: false,
      n: 2,
    }),
  );
  await sealAcceptedSubmission({
    cwd: input.request.cwd,
    home: input.request.home,
    runId: runIdFromRunDirectory(input.request.runDirectory)!,
    runDirectory: input.request.runDirectory,
    role: input.role,
    details: input.details,
    toolCallId: input.toolCallId,
    // #1199 J3: this-turn seal must tag the live courtAttemptId.
    ...(input.request.courtAttemptId === undefined
      ? {}
      : { courtAttemptId: input.request.courtAttemptId }),
  });
}

/** completed enters the worker→inspector gate; ticketNumber relocates unbound→ticket. */
const FIXER_COMPLETED = {
  status: "completed" as const,
  report: "Class repaired; ticket bound.",
  ticketNumber: TICKET,
  classResults: [{
    name: "ParserCase",
    disposition: "completed" as const,
    searchScope: "src",
    exceptions: [] as const,
    commitSha: "a".repeat(40),
  }],
};

const INSPECTOR_CONTINUE = {
  status: "continue" as const,
  note: "继续修内司",
};

test("#1169 through-line: unbound→ticket→inspector→resume without package unbound paths", async () => {
  await withHermeticHome({ prefix: "ak-1169-through-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await seedPublicSeat(home, "fixer", { name: ENGINE, model: ENGINE_MODEL });
    await configurePassingReviewSeats(home);
    await seedPublicSeat(home, "inspector", { name: ENGINE, model: ENGINE_MODEL });

    const attachRel = "notes/evidence.md";
    await mkdir(join(project, "notes"), { recursive: true });
    await writeFile(join(project, attachRel), "evidence-v1", "utf8");
    const prereqPath = join(home, "prereqs.json");
    await writeFile(prereqPath, "{ not-json", "utf8");
    const callerPaths = [attachRel, prereqPath];
    const peerBody = JSON.stringify(FIXER_COMPLETED);

    const captures: Captured[] = [];
    let unboundRunDirectory: string | undefined;
    let fixerTurns = 0;

    const host: RoleTurnHost = createMinimalHost(async (request) => {
      if (request.activation.role === "inspector") {
        captures.push(await capturePreparedEnvelope(request));
        await sealTerminatingTurn({
          request,
          role: "inspector",
          toolName: INSPECTOR_OUTPUT_TOOL_NAME,
          details: INSPECTOR_CONTINUE,
          toolCallId: "inspector-1169",
        });
        return { code: 0, stderr: "", timedOut: false };
      }
      if (request.activation.role === "fixer") {
        fixerTurns += 1;
        const captured = await capturePreparedEnvelope(request);
        captures.push(captured);
        if (fixerTurns === 1) {
          unboundRunDirectory = request.runDirectory;
          assert.match(
            request.runDirectory,
            /[/\\]unbound[/\\]runs[/\\]/,
            "first fixer turn must start under unbound/",
          );
          await sealTerminatingTurn({
            request,
            role: "fixer",
            toolName: FIXER_OUTPUT_TOOL_NAME,
            details: FIXER_COMPLETED,
            toolCallId: "fixer-1169",
          });
          return { code: 0, stderr: "", timedOut: false };
        }
        // Gate-continue auto-resume: observe the second fixer turn, then stop.
        const coords = piDurablePrincipalAuthority.decode(request.principal);
        await writeSessionJsonl(coords.sessionFile, []);
        return { code: 1, stderr: "stop after resume capture", timedOut: false };
      }
      return { code: 0, stderr: "", timedOut: false };
    });

    const runId = "run-1169-through-fixer";
    const result = await runAkRole([
      "fixer",
      "--model", SEAT,
      "--project", project,
      "--attach", attachRel,
      "--prerequisites", prereqPath,
      DISPATCH,
    ], {
      packageRoot,
      home,
      cwd: project,
      io: captureIo().io,
      credentials: CREDS,
      createRunId: () => runId,
      principalAuthority: piDurablePrincipalAuthority,
      roleTurnHost: host,
    });
    assert.ok(
      result.exitCode === 0 || result.exitCode === 1,
      `public entry must reach host turns; exit=${result.exitCode}`,
    );
    assert.ok(unboundRunDirectory !== undefined, "unbound run directory was not observed");
    assert.ok(fixerTurns >= 2, `fixer must auto-resume after inspector continue; turns=${fixerTurns}`);

    const bookKey = resolveBookKeyFromGit(project);
    const ticketRunDirectory = join(
      home, ".ak-roles", "books", bookKey, String(TICKET), "runs", `${runId}@fixer`,
    );
    assert.equal(
      existsSync(ticketRunDirectory),
      true,
      `fixer must relocate under ticket ${TICKET}`,
    );
    assert.equal(
      existsSync(unboundRunDirectory),
      false,
      "unbound leaf must be gone after relocate",
    );

    const topLevel = new Set(await readdir(ticketRunDirectory));
    for (const required of ["current.json", "history.jsonl", "state.jsonl", "log.jsonl"]) {
      assert.equal(topLevel.has(required), true, `topology requires ${required}`);
    }
    // #1199: session originals stay under the leg (`<run>/session`).
    const { sessionDirectoryOf } = await import("../../src/role-run-placement.ts");
    assert.equal(existsSync(sessionDirectoryOf(ticketRunDirectory)), true, "topology requires leg session/");
    for (const forbidden of ["attachments", "fix-packet.md", "task.md", "prerequisites.json"]) {
      assert.equal(topLevel.has(forbidden), false, `topology forbids ${forbidden}`);
    }

    const inspector = captures.find((c) => c.role === "inspector");
    assert.ok(inspector !== undefined, "gate must summon inspector");

    const fixerCaptures = captures.filter((c) => c.role === "fixer");
    assert.ok(fixerCaptures.length >= 2, "need fixer initial + resume captures");
    assertNoUnboundPrefix(
      "fixer-initial",
      fixerCaptures[0]!.prompt,
      fixerCaptures[0]!.materials,
      unboundRunDirectory,
      callerPaths,
    );
    assertNoUnboundPrefix(
      "fixer-resume",
      fixerCaptures[1]!.prompt,
      fixerCaptures[1]!.materials,
      unboundRunDirectory,
      callerPaths,
    );
    assertNoUnboundPrefix(
      "inspector",
      inspector.prompt,
      inspector.materials,
      unboundRunDirectory,
      [...callerPaths, peerBody, DISPATCH],
    );

    // Relocated admitted page keeps caller paths opaque; no frozenPath.
    const current = JSON.parse(await readFile(join(ticketRunDirectory, "current.json"), "utf8")) as {
      admitted: {
        attachments: Array<Record<string, unknown>>;
        prerequisitesPath?: string;
      };
    };
    assert.deepEqual(
      current.admitted.attachments.map((a) => a.path),
      [attachRel],
    );
    assert.equal(current.admitted.prerequisitesPath, prereqPath);
    for (const attachment of current.admitted.attachments) {
      assert.equal("frozenPath" in attachment, false);
    }
  });
});
