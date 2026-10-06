/**
 * Shared public-entry + fake-host seat project assembly for #1171 report-ticket
 * integration tests. One foundation — consumers must not fork a second copy.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import {
  loadPublicCliConfig,
  savePublicCliConfig,
  setPersistentSeatConfig,
} from "../../src/public-cli/config.ts";
import { runPublicInstructionSeat } from "../../src/public-cli/instruction-seat-run.ts";
import type { PublicConfigurableSeat } from "../../src/public-cli/registry.ts";
import { seedGitProject } from "./failure-settlement-kit.ts";
import { installGhFixture } from "./hermes-fixture.ts";
import { configurePassingReviewSeats } from "./passing-review-host.ts";
import { addRoleRepoOrigin, packageRoot } from "./pi-test-harness.ts";
import { withPrimaryAwareCleanup, withTempRoot } from "./primary-aware-cleanup.ts";

const DEFAULT_SEAT_ROLES = [
  "fixer",
  "secretariat",
  "diarist",
  "countersign",
] as const satisfies readonly PublicConfigurableSeat[];

export function unboundLeaf(
  home: string,
  bookKey: string,
  runId: string,
  role: string,
): string {
  return join(home, ".ak-roles", "books", bookKey, "unbound", "runs", `${runId}@${role}`);
}

export function ticketLeaf(
  home: string,
  bookKey: string,
  ticket: number,
  runId: string,
  role: string,
): string {
  return join(home, ".ak-roles", "books", bookKey, String(ticket), "runs", `${runId}@${role}`);
}

export async function withReportTicketSeatProject(
  run: (ctx: { home: string; project: string; bookKey: string }) => Promise<void>,
  options?: {
    readonly prefix?: string;
    readonly ticket?: number;
    readonly seatRoles?: readonly PublicConfigurableSeat[];
  },
): Promise<void> {
  const ticket = options?.ticket ?? 1171;
  const seatRoles: readonly PublicConfigurableSeat[] = options?.seatRoles ?? DEFAULT_SEAT_ROLES;
  await withTempRoot(options?.prefix ?? "ak-report-ticket-", async (home) => {
    const binDir = join(home, "bin");
    const priorPath = process.env.PATH;
    process.env.PATH = `${binDir}:${priorPath ?? ""}`;
    await withPrimaryAwareCleanup(
      async () => {
        const project = join(home, "project");
        await mkdir(project, { recursive: true });
        seedGitProject(project);
        addRoleRepoOrigin(project);
        await installGhFixture(binDir, {
          issues: { [ticket]: { body: "issue body", comments: [] } },
        });
        await configurePassingReviewSeats(home);
        let config = await loadPublicCliConfig(home);
        const seat = { provider: "test", model: "caller-seat", thinking: "high" } as const;
        for (const role of seatRoles) {
          config = setPersistentSeatConfig(config, role, seat);
        }
        await savePublicCliConfig(config, home);
        await run({ home, project, bookKey: resolveBookKeyFromGit(project) });
      },
      async () => {
        if (priorPath === undefined) delete process.env.PATH;
        else process.env.PATH = priorPath;
      },
    );
  });
}

export function reportTicketSeatEnv(
  home: string,
  project: string,
  runId: string,
  host: string,
  roleTurnHost: NonNullable<Parameters<typeof runPublicInstructionSeat>[1]["roleTurnHost"]>,
  extra?: {
    readonly autoResumeLimit?: number;
    readonly hostAdapters?: Parameters<typeof runPublicInstructionSeat>[1]["hostAdapters"];
  },
) {
  return {
    home,
    agentDir: join(home, ".pi"),
    packageRoot,
    cwd: project,
    principalAuthority: piDurablePrincipalAuthority,
    sessionAppender: appendPiSessionCustomEntry,
    roleTurnHost,
    createRunId: () => runId,
    host,
    ...(extra?.autoResumeLimit === undefined ? {} : { autoResumeLimit: extra.autoResumeLimit }),
    ...(extra?.hostAdapters === undefined ? {} : { hostAdapters: extra.hostAdapters }),
  };
}
