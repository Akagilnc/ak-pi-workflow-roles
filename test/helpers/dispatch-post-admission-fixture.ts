/**
 * Shared fixture for tests that dispatch dispatchPostAdmissionTurn directly
 * (src/public-cli/post-admission.ts): one admitted judge run seeded through
 * the real markRunAdmitted seam, plus the default initial RoleTurnRequest
 * and PostAdmissionEnv every case needs. Callers override only what varies.
 * Used by #840 r9 判词 class 2 regressions in
 * test/integration/public-cli-dispatch-post-admission-turn-boundary.test.ts
 * and test/integration/public-cli-auto-resume-dispatch-throw.test.ts.
 * courtAttemptId-bearing scenarios (clearCurrentCourt) moved to a real
 * `ak-role resume` tracer at test/integration/public-cli-same-ticket-resume.test.ts —
 * this fixture no longer needs to seed an open court.
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import type {
  DurablePrincipalAuthority,
  RoleTurnHost,
  RoleTurnRequest,
} from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import type { PostAdmissionEnv } from "../../src/public-cli/post-admission.ts";
import { markRunAdmitted } from "../../src/public-cli/run-lifecycle.ts";
import { packageRoot } from "./pi-test-harness.ts";
import { fixturePrincipal } from "./admitted-principal-fixture.ts";

export function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "840@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "840"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

export async function buildFixture(
  home: string,
  runId: string,
  options?: { readonly ticketNumber?: number },
) {
  const project = join(home, "proj");
  await mkdir(project, { recursive: true });
  seedGitProject(project);
  const bookKey = resolveBookKeyFromGit(project);
  const runDirectory = join(home, ".ak-roles", "books", bookKey, "runs", `${runId}@judge`);
  const sessionDirectory = join(runDirectory, "session");
  const sessionFile = join(sessionDirectory, "session.jsonl");
  await mkdir(sessionDirectory, { recursive: true });
  const admittedRequestPath = join(runDirectory, "admitted-request.json");
  await writeFile(admittedRequestPath, "{}\n", "utf8");
  const admitted = {
    role: "judge" as const,
    runId,
    bookKey,
    projectRoot: project,
    instruction: "x",
    instructionEmpty: false,
    attachments: [],
    runDirectory,
    principal: fixturePrincipal(sessionDirectory, sessionFile),
    admittedRequestPath,
    ...(options?.ticketNumber === undefined ? {} : { ticketNumber: options.ticketNumber }),
  };
  await markRunAdmitted(admitted, piDurablePrincipalAuthority);
  // markRunAdmitted does not create invocation.json (it owns run-state.json
  // only) — markRunRunning's recordEffectiveInvocationModel merges into an
  // already-existing page, matching the real admission facade's write order.
  await writeFile(join(runDirectory, "invocation.json"), "{}\n", "utf8");
  const request: RoleTurnRequest = {
    principal: admitted.principal,
    activation: { role: "judge" },
    methods: [],
    continuation: { kind: "initial", prompt: "go" },
    cwd: project,
    home,
    agentDir: join(runDirectory, "agent"),
    runDirectory,
  };
  return { admitted, project, runDirectory, request };
}

/** Shared env literal every test dispatches with; only overrides vary. */
export function buildEnv(
  fixture: { readonly project: string; readonly runDirectory: string },
  home: string,
  roleTurnHost: RoleTurnHost,
  overrides?: {
    readonly principalAuthority?: DurablePrincipalAuthority;
    readonly home?: string;
    readonly host?: string;
  },
): PostAdmissionEnv {
  return {
    home: overrides?.home ?? home,
    agentDir: join(fixture.runDirectory, "agent"),
    packageRoot,
    cwd: fixture.project,
    roleTurnHost,
    principalAuthority: overrides?.principalAuthority ?? piDurablePrincipalAuthority,
    sessionAppender: appendPiSessionCustomEntry,
    ...(overrides?.host === undefined ? {} : { host: overrides.host }),
  };
}
