/**
 * #1183 — after ticket identity, run lives under the ticket leaf; current.json
 * location paths match that leaf during the turn, after no_receipt, and after
 * public resume. Historical state.jsonl rows keep their original path bytes.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parsePublicSeatArgv } from "../../src/public-cli/invocation.ts";
import {
  runPublicInstructionSeat,
  runPublicInstructionSeatResume,
} from "../../src/public-cli/instruction-seat-run.ts";
import { FIXER_OUTPUT_TOOL_NAME } from "../../src/package-contracts/worker-output.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { sessionDirectoryOf, sessionFileOf } from "../../src/role-run-placement.ts";
import { captureIo } from "../helpers/failure-settlement-kit.ts";
import { withPassingReviewHost } from "../helpers/passing-review-host.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  reportTicketSeatEnv as seatEnv,
  ticketLeaf,
  unboundLeaf,
  withReportTicketSeatProject as withSeatProject,
} from "../helpers/report-ticket-seat-project.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
  argvFlagValue,
} from "../helpers/role-turn-host-fixture.ts";
import { readCurrentJson } from "../helpers/run-dossier-fixture.ts";

const TICKET = 1183;
const RUN_ID = "01a011830-0000-7000-8000-0000000paths";

const FIXER_DONE = {
  status: "completed",
  report: "done",
  classResults: [{
    name: "main",
    disposition: "completed",
    searchScope: "src",
    exceptions: [],
    commitSha: "abc1234",
  }],
} as const;

function assertCurrentLocationPaths(runDirectory: string, label: string): void {
  const current = readCurrentJson(runDirectory);
  const expectedSessionDirectory = sessionDirectoryOf(runDirectory);
  const expectedSessionFile = sessionFileOf(runDirectory);
  for (const section of ["invocation", "admitted", "runState"] as const) {
    const page = current[section];
    assert.ok(page !== undefined && typeof page === "object" && page !== null, `${label}: ${section}`);
    const record = page as Record<string, unknown>;
    assert.equal(record.runDirectory, runDirectory, `${label}: ${section}.runDirectory`);
    assert.equal(
      existsSync(String(record.runDirectory)),
      true,
      `${label}: ${section}.runDirectory must exist`,
    );
    if (typeof record.sessionDirectory === "string") {
      assert.equal(record.sessionDirectory, expectedSessionDirectory, `${label}: ${section}.sessionDirectory`);
      assert.equal(existsSync(record.sessionDirectory), true, `${label}: sessionDirectory exists`);
    }
    if (typeof record.sessionFile === "string") {
      assert.equal(record.sessionFile, expectedSessionFile, `${label}: ${section}.sessionFile`);
    }
  }
}

test("#1183 report-ticket then no_receipt: ticket leaf + current paths; history keeps unbound bytes", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    let midTurnError: unknown;
    let unboundAtReport: string | undefined;

    const roleTurnHost = withPassingReviewHost({
      async executeTurn(request) {
        try {
          unboundAtReport = request.runDirectory;
          assert.match(request.runDirectory, /[/\\]unbound[/\\]runs[/\\]/);

          const { reportTicketFromHostContext } = await import("../../src/report-ticket-tool.ts");
          const { SessionManager } = await import("@earendil-works/pi-coding-agent");
          const { mkdir, writeFile } = await import("node:fs/promises");
          const { dirname } = await import("node:path");
          const { existsSync: exists } = await import("node:fs");

          const sessionFile = piDurablePrincipalAuthority.decode(request.principal).sessionFile;
          const sessionDir = dirname(sessionFile!);
          await mkdir(sessionDir, { recursive: true });
          if (!exists(sessionFile!)) await writeFile(sessionFile!, "", "utf8");
          const sessionManager = SessionManager.open(sessionFile!, sessionDir, project);
          const context = {
            cwd: project,
            mode: "rpc" as const,
            model: undefined,
            runDirectory: request.runDirectory,
            sessionManager: {
              getLeafEntry: () => sessionManager.getLeafEntry(),
              getLeafId: () => sessionManager.getLeafId(),
              getEntries: () => sessionManager.getEntries(),
              getSessionDir: () => sessionManager.getSessionDir(),
              getSessionFile: () => sessionManager.getSessionFile(),
              getHeader: () => sessionManager.getHeader(),
              setSessionFile: (path: string) => sessionManager.setSessionFile(path),
              appendCustomEntry: (customType: string, data: unknown) =>
                sessionManager.appendCustomEntry(customType, data),
            },
            abort() {},
          };
          const reported = await reportTicketFromHostContext(context, TICKET);
          assert.equal(reported.relocated, true);

          const live = ticketLeaf(home, bookKey, TICKET, RUN_ID, "fixer");
          assert.equal(exists(live), true, "mid-turn: physical ticket leaf");
          assert.equal(exists(unboundLeaf(home, bookKey, RUN_ID, "fixer")), false, "mid-turn: unbound gone");
          assertCurrentLocationPaths(live, "mid-turn after report-ticket");

          // no_receipt: host returns without a sealed submission.
          return { code: 0, stderr: "", timedOut: false };
        } catch (error) {
          midTurnError = error;
          throw error;
        }
      },
    });

    const result = await runPublicInstructionSeat(
      ["apply", "Repair #1183."],
      seatEnv(home, project, RUN_ID, "pi", roleTurnHost, { autoResumeLimit: 0 }),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );

    if (midTurnError !== undefined) {
      assert.fail(`mid-turn failed: ${midTurnError instanceof Error ? midTurnError.stack ?? midTurnError.message : String(midTurnError)}`);
    }
    assert.equal(result.terminal?.roleOutcome.kind, "no_receipt");
    const live = ticketLeaf(home, bookKey, TICKET, RUN_ID, "fixer");
    assert.equal(existsSync(live), true, "after no_receipt: still under ticket");
    assert.equal(existsSync(unboundLeaf(home, bookKey, RUN_ID, "fixer")), false);
    assert.equal(result.admitted?.runDirectory, live);
    assertCurrentLocationPaths(live, "after no_receipt");

    // Historical append rows keep the unbound path bytes they were written with.
    assert.ok(unboundAtReport !== undefined);
    const stateRaw = await readFile(join(live, "state.jsonl"), "utf8");
    assert.ok(
      stateRaw.includes(unboundAtReport!),
      "state.jsonl must retain pre-relocate unbound path bytes",
    );

    // Public resume keeps the same location contract.
    let resumeSession: string | undefined;
    const resumeHost = withPassingReviewHost(roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        resumeSession = argvFlagValue(args, "--session");
        return scriptedTerminatingToolSession({
          role: "fixer",
          toolName: FIXER_OUTPUT_TOOL_NAME,
          details: { ...FIXER_DONE, ticketNumber: TICKET },
          sessionWriteMode: "append",
        })(args, options);
      },
    }));
    const resumed = await runPublicInstructionSeatResume(
      { runId: RUN_ID, message: "continue after #1183 no_receipt" },
      seatEnv(home, project, RUN_ID, "pi", resumeHost),
      captureIo().io,
    );
    assert.ok(resumeSession?.startsWith(join(live, "session")));
    assert.equal(resumed.admitted?.runDirectory, live);
    assert.equal(existsSync(unboundLeaf(home, bookKey, RUN_ID, "fixer")), false);
    assertCurrentLocationPaths(live, "after public resume");
  }, { ticket: TICKET, prefix: "ak-1183-paths-" });
});

test("#1183 unknown ticket identity stays unbound", async () => {
  await withSeatProject(async ({ home, project, bookKey }) => {
    const runId = "01a011830-0000-7000-8000-0000000none";
    const roleTurnHost = withPassingReviewHost({
      async executeTurn() {
        return { code: 0, stderr: "", timedOut: false };
      },
    });
    const result = await runPublicInstructionSeat(
      ["apply", "No ticket yet."],
      seatEnv(home, project, runId, "pi", roleTurnHost, { autoResumeLimit: 0 }),
      captureIo().io,
      "fixer",
      (args) => parsePublicSeatArgv("fixer", args),
    );
    assert.equal(result.terminal?.roleOutcome.kind, "no_receipt");
    const unbound = unboundLeaf(home, bookKey, runId, "fixer");
    assert.equal(existsSync(unbound), true);
    assert.equal(existsSync(ticketLeaf(home, bookKey, TICKET, runId, "fixer")), false);
    assertCurrentLocationPaths(unbound, "unbound no_receipt");
  }, { ticket: TICKET, prefix: "ak-1183-unbound-" });
});
