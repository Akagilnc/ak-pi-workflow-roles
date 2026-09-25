/**
 * #505 route, submission, and settlement tracer.
 * One public entry (runAkRole) per active registry seat.
 * The host argv role is the route. The sealed terminal and report.json are the
 * submission and settlement faces. Navigator routebook read failure stays an
 * advisory diagnostic and leaves the accepted receipt in place.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { PUBLIC_ROLE_RECORDS } from "../../src/packaged-role-registry.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import type { TerminalRoleName } from "../../src/public-cli/terminal.ts";
import { DOCTOR_CANDIDATE_ENTRY_TYPE } from "../../src/dossier-resolution.ts";
import { configurePassingReviewSeats } from "../helpers/passing-review-host.ts";
import { seedDoctorIssueRuns } from "../helpers/doctor-fixtures.ts";
import { seedCanonicalSourceRun } from "../helpers/notary-fixtures.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { publicSeatSummonArgv } from "../helpers/public-seat-summon-argv.ts";
import {
  argvFlagValue,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";

const TICKET = 505;
const ROUTEBOOK_FAILURE = "missing playbook";
const ROUTEBOOK_INVOCATION = "01a05052-0000-7000-8000-000000000099";

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "pipeline@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Pipeline Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

test("#505 every active seat routes, submits, and settles from the public entry", async () => {
  await withTempRoot("ak-seat-pipeline-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRun = await seedCanonicalSourceRun(home, project, { ticketNumber: TICKET });
    await seedDoctorIssueRuns(home, resolveBookKeyFromGit(project), TICKET);
    const quiet = { stdout() {}, stderr(_text: string) {} };
    await runAkRole(["config", "set-auto-resume-limit", "0"], {
      home,
      packageRoot,
      cwd: project,
      io: quiet,
    });
    // Nested court diarist does not inherit the parent argv model.
    await runAkRole(["config", "set", "diarist", "openai-codex/gpt-5.6-sol:high"], {
      home,
      packageRoot,
      cwd: project,
      io: quiet,
    });
    await configurePassingReviewSeats(home);
    await runAkRole(["config", "set", "countersign", "test/caller-seat:high"], { home, packageRoot, cwd: project, io: quiet });
    let n = 0;
    const failures: string[] = [];
    const firstRunDirectory = new Map<string, string>();
    for (const record of PUBLIC_ROLE_RECORDS) {
      const routed: string[] = [];
      const stderr: string[] = [];
      const host = roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args, options) => {
          const role = argvFlagValue(args, "--ak-role");
          const seat = PUBLIC_ROLE_RECORDS.find((item) => item.role === role);
          assert.ok(seat, `public host argv has no registry role: ${role ?? ""}`);
          routed.push(seat.role);
          const written = await scriptedTerminatingToolSession({
            role: seat.role as TerminalRoleName,
            toolName: seat.outputTool,
            details: seat.role === "secretariat" ? { secretariatStatus: "converged" }
              : seat.role === "judge" || seat.role === "countersign" || seat.role === "inspector" || seat.role === "notary" || seat.role === "auditor"
                ? { status: "converged" } : { status: "completed" },
          })(args, options);
          if (seat.role === "doctor") {
            const sessionFile = argvFlagValue(args, "--session");
            assert.ok(sessionFile);
            await appendFile(sessionFile, `${JSON.stringify({ type: "custom", customType: DOCTOR_CANDIDATE_ENTRY_TYPE })}\n`, "utf8");
          }
          if (seat.role === "navigator") {
            const sessionFile = argvFlagValue(args, "--session");
            assert.ok(sessionFile);
            const prior = await readFile(sessionFile, "utf8");
            const marker = JSON.stringify({
              type: "custom",
              customType: "ak-navigator-invocation",
              data: {
                invocationId: ROUTEBOOK_INVOCATION,
                role: "navigator",
                phase: null,
                subjectKey: "subject",
              },
            });
            const attendance = JSON.stringify({
              type: "custom_message",
              customType: "ak-navigator-attendance",
              message: {
                details: {
                  invocationId: ROUTEBOOK_INVOCATION,
                  disposition: "no-advice",
                  routePlaybookReadFailure: ROUTEBOOK_FAILURE,
                },
              },
            });
            await writeFile(sessionFile, `${marker}\n${prior}${attendance}\n`, "utf8");
          }
          return written;
        },
      });
      const result = await runAkRole(
        publicSeatSummonArgv(record.role, project, sourceRun, TICKET),
        {
          home,
          packageRoot,
          cwd: project,
          io: {
            stdout() {},
            stderr(text: string) {
              stderr.push(text);
            },
          },
          boundTicketNumber: TICKET,
          hostAdapters: [{ name: "pi", create: () => ({ ok: true as const, host }) }],
          principalAuthority: piDurablePrincipalAuthority,
          createRunId: () => `01a05052-0000-7000-8000-${String(++n).padStart(12, "0")}`,
        },
      );
      const outcome = result.terminal?.roleOutcome;
      const report = result.terminal?.artifacts.find((artifact) => artifact.kind === "report");
      let reportRole: unknown;
      if (report !== undefined) {
        const body = JSON.parse(await readFile(report.path, "utf8")) as { role?: unknown };
        reportRole = body.role;
      }
      const problems: string[] = [];
      if (!routed.includes(record.role)) {
        problems.push(`route missed ${record.role}; saw ${routed.join(",") || "(none)"}`);
      }
      if (result.exitCode !== 0) problems.push(`exit ${result.exitCode}`);
      if (outcome?.kind !== "accepted" || outcome.role !== record.role) {
        problems.push(`outcome ${outcome?.kind ?? "missing"}:${outcome && "role" in outcome ? outcome.role : ""}`);
      }
      if (reportRole !== record.role) problems.push(`report role ${String(reportRole)}`);
      if (
        report !== undefined
        && (record.role === "diarist" || record.role === "countersign")
      ) {
        firstRunDirectory.set(record.role, dirname(dirname(report.path)));
      }
      if (record.role === "navigator") {
        const navigator = result.terminal?.navigator;
        if (navigator?.advisoryDiagnostic !== ROUTEBOOK_FAILURE) {
          problems.push(`routebook diagnostic ${String(navigator?.advisoryDiagnostic)}`);
        }
        if (outcome?.kind !== "accepted") problems.push("routebook failure changed the receipt");
      }
      if (problems.length > 0) {
        failures.push(`${record.role}: ${problems.join("; ")} stderr=${stderr.at(-1) ?? ""}`);
      }
    }
    assert.deepEqual(failures, []);
    for (const role of ["diarist", "countersign"] as const) {
      const host = roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: async (args, options) => {
          const argvRole = argvFlagValue(args, "--ak-role");
          const seat = PUBLIC_ROLE_RECORDS.find((item) => item.role === argvRole);
          assert.ok(seat);
          return scriptedTerminatingToolSession({
            role: seat.role as TerminalRoleName,
            toolName: seat.outputTool,
            details: seat.role === "countersign" || seat.role === "notary"
              ? { status: "converged" } : { status: "completed" },
          })(args, options);
        },
      });
      const again = await runAkRole(
        publicSeatSummonArgv(role, project, sourceRun, TICKET),
        {
          home,
          packageRoot,
          cwd: project,
          io: { stdout() {}, stderr() {} },
          boundTicketNumber: TICKET,
          hostAdapters: [{ name: "pi", create: () => ({ ok: true as const, host }) }],
          principalAuthority: piDurablePrincipalAuthority,
          createRunId: () => `01a05052-0000-7000-8000-${String(++n).padStart(12, "0")}`,
        },
      );
      const report = again.terminal?.artifacts.find((artifact) => artifact.kind === "report");
      assert.ok(report, `${role} second public summons produced no report`);
      const second = dirname(dirname(report.path));
      assert.notEqual(second, firstRunDirectory.get(role), `${role} public re-summons resumed by ticket`);
      assert.ok(second.includes(`${join("505", "runs")}`), `${role} second run left the ticket: ${second}`);
    }
  });
});
