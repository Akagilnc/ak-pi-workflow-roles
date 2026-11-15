/**
 * Public-entry court fixtures: a temp home with the court seats configured, the
 * one configured resume limit, a fresh git project, and a Secretariat court.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { RoleTurnHost } from "../../src/host-contracts.ts";
import { packagedExternalHostNames } from "../../src/host-descriptions.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { withTempRoot } from "./environment-fixtures.ts";
import { captureIo, seedGitProject } from "./failure-settlement-kit.ts";
import { configurePassingReviewSeats } from "./passing-review-host.ts";
import { packageRoot } from "./pi-test-harness.ts";

export async function withSeatHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-1132-", async (home) => {
    await runAkRole(
      ["config", "set", "judge", "test/caller-seat:high", "diarist", "test/caller-seat:high", "countersign", "test/caller-seat:high"],
      { packageRoot, home, io: { stdout() {}, stderr() {} } },
    );
    // The review seats must resolve for 不跳审核 to be observable at all.
    await configurePassingReviewSeats(home);
    return fn(home);
  });
}

/** #1132 怎么验: drive the one configured value through the public config entry. */
export async function setConfiguredLimit(home: string, limit: number): Promise<void> {
  await runAkRole(["config", "set-auto-resume-limit", String(limit)], {
    packageRoot,
    home,
    io: { stdout() {}, stderr() {} },
  });
}

export async function freshProject(home: string): Promise<string> {
  const project = join(home, `proj-${Math.random().toString(36).slice(2)}`);
  await mkdir(project, { recursive: true });
  seedGitProject(project);
  return project;
}

/**
 * A Secretariat court on the public entry. `host` serves every seat under the
 * configured limit; `open` starts a Secretariat run and `resume` continues one.
 */
export async function withSecretariatCourt(
  limit: number,
  host: RoleTurnHost,
  scenario: (court: {
    readonly home: string;
    readonly project: string;
    open(runId?: string): ReturnType<typeof runAkRole>;
    resume(runId: string): ReturnType<typeof runAkRole>;
  }) => Promise<void>,
): Promise<void> {
  await withSeatHome(async (home) => {
    await setConfiguredLimit(home, limit);
    await runAkRole(
      ["config", "set", "secretariat", "test/caller-seat:high", "notary", "test/caller-seat:high", "auditor", "test/caller-seat:high"],
      { packageRoot, home, io: { stdout() {}, stderr() {} } },
    );
    const project = await freshProject(home);
    const env = {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true as const, xai: true as const },
      io: captureIo().io,
      roleTurnHost: host,
      hostAdapters: packagedExternalHostNames()
        .concat("pi")
        .map((name) => ({ name, create: () => ({ ok: true as const, host }) })),
    };
    await scenario({
      home,
      project,
      open: (runId) => runAkRole(
        ["secretariat", "--host", "grok-build", "--project", project, "go"],
        runId === undefined ? env : { ...env, createRunId: () => runId },
      ),
      resume: (runId) => runAkRole(["resume", runId], env),
    });
  });
}
