/**
 * #505 admission and load tracer. Real entry is runAkRole.
 * A typed ticket already on the summons places every active public seat under
 * that ticket. When that entry builds a host turn, its method paths are the
 * packaged skill files named by the seat record.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { sep } from "node:path";
import { join } from "node:path";
import test from "node:test";

import {
  activationBookDirectory,
  resolveActivationLedgerHome,
} from "../../src/activation-ledger-topology.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import type { RoleTurnHost, RoleTurnRequest } from "../../src/host-contracts.ts";
import { resolvePackagedMethodSkillPath, type PackagedMethodSkillName } from "../../src/package-resources/method-skill.ts";
import { PUBLIC_ROLE_RECORDS, type PublicRoleRecord } from "../../src/packaged-role-registry.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { listBookRunDirectories } from "../../src/role-run-placement.ts";
import {
  CANONICAL_SOURCE_RUN_ID,
  seedCanonicalSourceRun,
} from "../helpers/notary-fixtures.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { publicSeatSummonArgv } from "../helpers/public-seat-summon-argv.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

const TICKET = 505;

/** Turn-request skill paths for one registry record. Coder's public argv defaults to apply. */
function packagedTurnMethodPaths(record: PublicRoleRecord): string[] {
  const names: PackagedMethodSkillName[] = [];
  if ("methodSkills" in record && record.methodSkills !== undefined) {
    names.push(...record.methodSkills);
  }
  if ("applyMethod" in record && record.applyMethod !== undefined && !names.includes(record.applyMethod)) {
    names.push(record.applyMethod);
  }
  return names.map((name) => resolvePackagedMethodSkillPath(packageRoot, name));
}

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "placement@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Placement Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

test("#505 known ticket places every active public seat under that ticket", async () => {
  await withTempRoot("ak-known-ticket-placement-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRun = await seedCanonicalSourceRun(home, project, { ticketNumber: TICKET });
    let n = 0;
    const seen = new Map<string, RoleTurnRequest[]>();
    const host: RoleTurnHost = {
      async executeTurn(request: RoleTurnRequest) {
        const turns = seen.get(request.activation.role) ?? [];
        turns.push(request);
        seen.set(request.activation.role, turns);
        return { code: 0, stderr: "", timedOut: false };
      },
    };
    const stderr: string[] = [];
    const io = {
      stdout: () => {},
      stderr: (text: string) => {
        stderr.push(text);
      },
    };
    for (const record of PUBLIC_ROLE_RECORDS) {
      const result = await runAkRole(publicSeatSummonArgv(record.role, project, sourceRun, TICKET), {
        home,
        packageRoot,
        cwd: project,
        io,
        boundTicketNumber: TICKET,
        roleTurnHost: host,
        createRunId: () =>
          `01a05050-0000-7000-8000-${String(++n).padStart(12, "0")}`,
      });
      const book = activationBookDirectory(
        resolveActivationLedgerHome(home),
        resolveBookKeyFromGit(project),
      );
      const turns = seen.get(record.role) ?? [];
      const runs = (await listBookRunDirectories(book)).filter(
        (dir) => dir.endsWith(`@${record.role}`) && !dir.includes(CANONICAL_SOURCE_RUN_ID),
      );
      const observed = turns.length > 0 ? turns.map((turn) => turn.runDirectory) : runs;
      const methodPaths = packagedTurnMethodPaths(record);
      for (const turn of turns) {
        assert.deepEqual(
          turn.methods.map((method) => method.path),
          methodPaths,
          `${record.role} turn methods are not the packaged skill paths`,
        );
      }
      assert.ok(
        observed.length >= 1,
        `${record.role} exit ${result.exitCode} produced no run stderr=${stderr.at(-1) ?? ""}`,
      );
      for (const dir of observed) {
        assert.ok(
          dir.includes(`${sep}${TICKET}${sep}runs${sep}`),
          `${record.role} runDirectory is not under ticket ${TICKET}: ${dir}`,
        );
        assert.equal(
          dir.includes(`${sep}unbound${sep}`),
          false,
          `${record.role} placed unbound: ${dir}`,
        );
      }
    }
  });
});
