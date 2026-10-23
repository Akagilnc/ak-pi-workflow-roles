/**
 * #1192 contract one — automatic attendance through the real public entry to the
 * real settlement: the parent's start summons a real `@navigator` run that looks
 * its rows up (no model, no host session); its settlement presents the row of the
 * parent's actual status. Oracles: structured events and run records.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vitest";
import { randomUUID } from "node:crypto";

import * as publicRoleSummons from "../../src/public-role-summons.ts";
import { publicCliConfigPath } from "../../src/public-cli/config.ts";
import { driveExternalRoleTurnRounds } from "../../src/external-host-turn-loop.ts";
import type { RoleTurnHost } from "../../src/host-contracts.ts";
import type { NavigatorAttendance, NavigatorEvent } from "../../src/navigator-attendance.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { parsePublicSeatArgv } from "../../src/public-cli/invocation.ts";
import { runPublicInstructionSeat } from "../../src/public-cli/instruction-seat-run.ts";
import { readPageSync } from "../../src/run-dossier.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { captureIo } from "../helpers/failure-settlement-kit.ts";
import { packageRoot, seedRoleRepo, waitForEventLoopCondition } from "../helpers/pi-test-harness.ts";
import { withActivationHome } from "../helpers/environment-fixtures.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/auditor-output.ts";

type Case = {
  readonly name: string;
  readonly role: "judge" | "coder" | "reviewer";
  readonly argv: readonly string[];
  readonly output: Record<string, unknown>;
  /** Row expected from the table; "none" = affirmative no-advice; "unavailable" = lookup run failed. */
  readonly expect: "advice" | "none" | "unavailable";
  /** A settled @navigator lookup run, none at all, or one whose own recording failed. */
  readonly lookupRuns: boolean | "failed";
  /** The parent role itself fails at the host: its result and cause stand. */
  readonly parentFails?: true;
  readonly mismatchedSeat?: true;
  readonly failingLookup?: true;
};

const judgeOut = (status: string) => ({
  status,
  ticketNumber: 1192,
  evidence: { checks: [{ name: "receipt", passed: true }] },
});
const workerOut = (status: string) => ({
  status, report: "r", remainingScope: "none", ticketNumber: 1192,
});

const CASES: readonly Case[] = [
  ...(["converged", "continue", "escalate"] as const).map((status): Case => ({
    name: `judge ${status}: the table row of the actual status`,
    role: "judge", argv: ["Canonical nonblank prose Judge request."], output: judgeOut(status),
    expect: "advice", lookupRuns: true,
  })),
  {
    name: "reviewer (single lens) completed: its row",
    role: "reviewer",
    argv: ["--lens", "correctness", "--base", "HEAD", "--authority-ref", "CLAUDE.md", "Review."],
    output: { status: "completed", amendments: { correctness: "ok" }, ticketNumber: 1192 },
    expect: "advice", lookupRuns: true,
  },
  {
    name: "parent host failure: its real cause stands, no advice is invented",
    role: "judge", argv: ["Canonical nonblank prose Judge request."], output: judgeOut("converged"),
    expect: "none", lookupRuns: false, parentFails: true,
  },
  {
    name: "navigator seat whose model and host do not match (xai/grok-4.5 on codex): still the row",
    role: "judge", argv: ["Canonical nonblank prose Judge request."], output: judgeOut("converged"),
    expect: "advice", lookupRuns: true, mismatchedSeat: true,
  },
  {
    name: "coder apply refused: its row",
    role: "coder", argv: ["apply", "Do the work."], output: workerOut("refused"),
    expect: "advice", lookupRuns: true,
  },
  {
    name: "coder apply planned: lawful status without a row is no-advice, nothing invented",
    role: "coder", argv: ["apply", "Do the work."], output: workerOut("planned"),
    expect: "none", lookupRuns: true,
  },
  {
    name: "coder plan refused: plan phase is switched off, no lookup run at all",
    role: "coder", argv: ["plan", "Plan the work."], output: workerOut("refused"),
    expect: "none", lookupRuns: false,
  },
  {
    name: "the lookup run cannot record itself: unavailable with its real cause, the role result is untouched",
    role: "judge", argv: ["Canonical nonblank prose Judge request."], output: judgeOut("converged"),
    expect: "unavailable", lookupRuns: "failed", failingLookup: true,
  },
];

for (const scenario of CASES) {
  test(scenario.name, async ({ onTestFinished }) => {
    await withActivationHome({ prefix: "ak-nav-attendance-" }, async ({ home }) => {
      const { runAkRole } = await import("../../src/public-cli/cli.ts");
      await runAkRole(
        ["config", "set", "judge", "test/caller-seat:high", "coder", "test/caller-seat:high",
          "notary", "test/caller-seat:high", "auditor", "test/caller-seat:high", "gatekeeper", "test/caller-seat:high"],
        { packageRoot, home, io: { stdout() {}, stderr() {} } },
      );
      if (scenario.mismatchedSeat === true) {
        // Fixture home only — never the real seat table.
        const config = JSON.parse(readFileSync(publicCliConfigPath(home), "utf8")) as { seats: Record<string, unknown> };
        config.seats.navigator = { provider: "xai", model: "grok-4.5", host: "codex" };
        await writeFile(publicCliConfigPath(home), JSON.stringify(config));
      }
      const project = join(home, "project");
      await mkdir(project, { recursive: true });
      seedRoleRepo(project);

      const events: NavigatorEvent[] = [];
      let complete!: () => void;
      const lookupCompletion = new Promise<void>((resolve) => { complete = resolve; });
      const summonPublicRole = publicRoleSummons.summonPublicRole;
      const summonSpy = vi.spyOn(publicRoleSummons, "summonPublicRole").mockImplementation(async (options) => {
        if (options.role !== "navigator") return summonPublicRole(options);
        try {
          return await summonPublicRole({
            ...options,
            ...(scenario.failingLookup === true ? {
              // Real filesystem fault: the lookup run's state file is a directory.
              createRunId: () => {
                const id = "01a0navi00-0000-7000-8000-00000000f001";
                mkdirSync(join(home, ".ak-roles", "books", "project", "unbound", "runs", `${id}@navigator`, "state.jsonl"), { recursive: true });
                return id;
              },
            } : {}),
          });
        } finally {
          // Observe the real public summons returning, not dispose or a grace projection.
          complete();
        }
      });
      onTestFinished(summonSpy.mockRestore);
      let attendance: NavigatorAttendance | undefined;
      const baseDeps = createRoleRuntimeDependencies(packageRoot);
      const deps = {
        ...baseDeps,
        createNavigatorAttendance: async (
          options: Parameters<NonNullable<typeof baseDeps.createNavigatorAttendance>>[0],
        ) => {
          attendance = await baseDeps.createNavigatorAttendance!({
            ...options,
            onEvent: async (event, report) => {
              events.push(event);
              await options.onEvent?.(event, report);
            },
          });
          return attendance;
        },
      };

      const officerHost = roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args, options) => {
          const role = args[args.indexOf("--ak-role") + 1];
          if (role === "notary" || role === "auditor") {
            return scriptedTerminatingToolSession({
              role,
              toolName: role === "notary" ? NOTARY_OUTPUT_TOOL_NAME : AUDITOR_OUTPUT_TOOL_NAME,
              details: { status: "converged", ticketNumber: 1192 },
            })(args, options);
          }
          throw new Error(`unexpected officer role: ${String(role)}`);
        },
      });
      const host: RoleTurnHost = {
        async executeTurn(request) {
          if (request.activation.role !== scenario.role) return officerHost.executeTurn(request);
          const prepared = await prepareRoleEnvelope({
            request: { ...request, host: "codex" },
            dependencies: deps,
            socketPath: `/tmp/ak-nav-1192-${randomUUID()}.sock`,
            listTerminatingToolOnMcp: false,
            sessionFile: piDurablePrincipalAuthority.decode(request.principal).sessionFile,
            principalAuthority: piDurablePrincipalAuthority,
          });
          try {
            return await driveExternalRoleTurnRounds(prepared, request, {
              roundLimitName: "StructuredOutputRoundLimit",
              currentSessionId: () => undefined,
              async runRound() {
                if (scenario.parentFails === true) return { status: "terminal" as const, result: { code: 1, stderr: "PARENT HOST BOOM", timedOut: false } };
                await prepared.ingestStructuredOutput(scenario.output);
                if (scenario.expect !== "none" || scenario.lookupRuns === true) {
                  await waitForEventLoopCondition(() => events.some((item) => item.disposition !== "arrival"), {
                    label: "navigator attendance must settle", timeoutMs: 8_000,
                  });
                }
                return { status: "delivered" as const };
              },
            });
          } finally {
            try {
              await prepared.dispose?.();
            } finally {
              // Observe production state, not the phase we expect it to use.
              if (attendance?.isPreparing()) await lookupCompletion;
            }
          }
        },
      };

      const { stdout, stderr, io } = captureIo();
      const result = await runPublicInstructionSeat(
        scenario.argv,
        {
          home,
          agentDir: join(home, ".pi"),
          packageRoot,
          cwd: project,
          principalAuthority: piDurablePrincipalAuthority,
          sessionAppender: appendPiSessionCustomEntry,
          credentials: { "openai-codex": true, xai: true },
          roleTurnHost: host,
          hostAdapters: [
            { name: "pi" as const, create: () => ({ ok: true as const, host }) },
            { name: "codex" as const, create: () => ({ ok: true as const, host }) },
          ],
          createRunId: () => "01a119200-0000-7000-8000-00000000run1",
        },
        io,
        scenario.role,
        (args) => parsePublicSeatArgv(scenario.role, args),
      );
      if (scenario.parentFails === true) {
        assert.equal(result.exitCode, 1);
        assert.equal(result.terminal?.roleOutcome.kind === "failure" ? result.terminal.roleOutcome.diagnostic : undefined, "PARENT HOST BOOM");
        assert.notEqual(result.terminal?.navigator.disposition, "advice");
        return;
      }
      assert.equal(result.exitCode, 0, stderr.join("") || stdout.join(""));
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");

      // The returned Terminal presents the navigator fact.
      const fact = result.terminal?.navigator;
      if (scenario.expect === "none") {
        assert.equal(fact?.disposition, "no-advice");
      } else if (scenario.expect === "unavailable") {
        assert.equal(fact?.disposition, "unavailable");
        if (fact?.disposition !== "unavailable") throw new Error("expected unavailable");
        // Same directory-as-file fault the lookup hits. Value-equal the opaque cause; do not lock the wrapper wording.
        const statePath = join(home, ".ak-roles", "books", "project", "unbound", "runs", "01a0navi00-0000-7000-8000-00000000f001@navigator", "state.jsonl");
        let reproduced = "";
        try {
          appendFileSync(statePath, "x", "utf8");
        } catch (error) {
          reproduced = error instanceof Error ? error.message : String(error);
        }
        assert.notEqual(reproduced, "");
        assert.equal(fact.reason.slice(fact.reason.length - reproduced.length), reproduced);
      } else {
        assert.equal(fact?.disposition, "advice");
      }

      // The lookup run, observed before cleanup: recorded as a lookup, with its own receipt, no session.
      const books = join(home, ".ak-roles", "books");
      const navigatorRuns = (await readdir(books, { recursive: true })).filter((path) => path.endsWith("@navigator"));
      assert.equal(navigatorRuns.length, scenario.lookupRuns === false ? 0 : 1);
      if (scenario.lookupRuns === "failed") {
        assert.equal(existsSync(join(books, navigatorRuns[0]!, "receipts", "1.json")), false);
      } else if (scenario.lookupRuns) {
        const runDirectory = join(books, navigatorRuns[0]!);
        assert.equal(existsSync(join(runDirectory, "session", "session.jsonl")), false);
        assert.equal(existsSync(join(runDirectory, "receipts", "1.json")), true);
        assert.equal(readPageSync(runDirectory, "invocation")?.host, "lookup");
        const lookup = JSON.parse(readFileSync(join(runDirectory, "receipts", "1.json"), "utf8")) as { byStatus: Record<string, string> };
        const status = scenario.output.status as string;
        if (fact?.disposition === "advice") {
          assert.equal(fact.prose, lookup.byStatus[status]);
          if (scenario.role === "judge") {
            for (const otherStatus of ["converged", "continue", "escalate"].filter((other) => other !== status)) {
              assert.notEqual(fact.prose, lookup.byStatus[otherStatus]);
            }
          }
        } else {
          assert.equal(lookup.byStatus[status], undefined);
        }
      }
    });
  });
}
