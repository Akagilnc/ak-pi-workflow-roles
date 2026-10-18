/**
 * #1192 contract one — automatic attendance through the real public entry to the
 * real settlement: the parent's start summons a real `@navigator` run that looks
 * its rows up (no model, no host session); its settlement presents the row of the
 * parent's actual status. Oracles: structured events and run records.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { driveExternalRoleTurnRounds } from "../../src/external-host-turn-loop.ts";
import type { RoleTurnHost } from "../../src/host-contracts.ts";
import type { NavigatorEvent } from "../../src/navigator-attendance.ts";
import { NAVIGATOR_ROUTE_TABLE } from "../../src/navigator-route-table.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { parsePublicSeatArgv } from "../../src/public-cli/invocation.ts";
import { runPublicInstructionSeat } from "../../src/public-cli/instruction-seat-run.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { captureIo } from "../helpers/failure-settlement-kit.ts";
import { packageRoot, seedRoleRepo, waitForEventLoopCondition, withActivationHome } from "../helpers/pi-test-harness.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/auditor-output.ts";

for (const status of ["converged", "continue"] as const) {
  test(`judge ${status}: the navigator run is a lookup and settlement presents the table row`, async () => {
    await withActivationHome({ prefix: "ak-nav-attendance-" }, async ({ home }) => {
      const { runAkRole } = await import("../../src/public-cli/cli.ts");
      await runAkRole(
        ["config", "set", "judge", "test/caller-seat:high", "notary", "test/caller-seat:high",
          "auditor", "test/caller-seat:high", "gatekeeper", "test/caller-seat:high"],
        { packageRoot, home, io: { stdout() {}, stderr() {} } },
      );
      const project = join(home, "project");
      await mkdir(project, { recursive: true });
      seedRoleRepo(project);

      const events: NavigatorEvent[] = [];
      const baseDeps = createRoleRuntimeDependencies(packageRoot);
      const deps = {
        ...baseDeps,
        createNavigatorAttendance: async (
          options: Parameters<NonNullable<typeof baseDeps.createNavigatorAttendance>>[0],
        ) => baseDeps.createNavigatorAttendance!({
          ...options,
          context: { ...(options.context as object), home } as never,
          onEvent: async (event, report) => {
            events.push(event);
            await options.onEvent?.(event, report);
          },
        }),
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
          if (request.activation.role !== "judge") return officerHost.executeTurn(request);
          const prepared = await prepareRoleEnvelope({
            request: { ...request, host: "codex" },
            dependencies: deps,
            socketPath: `/tmp/ak-nav-1192-${randomUUID()}.sock`,
            listTerminatingToolOnMcp: false,
            sessionFile: piDurablePrincipalAuthority.decode(request.principal).sessionFile,
            principalAuthority: piDurablePrincipalAuthority,
          });
          try {
            // The lookup starts with the parent; wait for its run to settle into the event.
            return await driveExternalRoleTurnRounds(prepared, request, {
              roundLimitName: "StructuredOutputRoundLimit",
              currentSessionId: () => undefined,
              async runRound() {
                await prepared.ingestStructuredOutput({
                  status,
                  ticketNumber: 1192,
                  evidence: { checks: [{ name: "receipt", passed: true }] },
                });
                await waitForEventLoopCondition(() => events.length > 0, {
                  label: "navigator attendance must settle", timeoutMs: 8_000,
                });
                return { status: "delivered" as const };
              },
            });
          } finally {
            await prepared.dispose?.();
          }
        },
      };

      const { stdout, stderr, io } = captureIo();
      const result = await runPublicInstructionSeat(
        ["Canonical nonblank prose Judge request for navigation."],
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
          createRunId: () => "01a119200-0000-7000-8000-0000000judge",
        },
        io,
        "judge",
        (args) => parsePublicSeatArgv("judge", args),
      );
      assert.equal(result.exitCode, 0, stderr.join("") || stdout.join(""));

      const event = events.find((item) => item.disposition !== "arrival");
      assert.equal(event?.disposition, "advice");
      assert.equal(event?.prose, NAVIGATOR_ROUTE_TABLE.judge?.[status]);

      // The nested @navigator run exists as a lookup: no host session, no model.
      const books = join(home, ".ak-roles", "books");
      const navigatorRuns = (await readdir(books, { recursive: true }))
        .filter((path) => path.endsWith("@navigator"));
      assert.equal(navigatorRuns.length, 1);
      assert.equal(existsSync(join(books, navigatorRuns[0]!, "session", "session.jsonl")), false);
    });
  });
}
