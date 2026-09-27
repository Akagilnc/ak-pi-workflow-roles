/**
 * #1092 — public entry must not freeze or fold a code-computed 起居录 path pointer.
 * Seams: runAkRole (bound + unbound) → run attachments; prepareRoleEnvelope materials.
 * Roles locate records by ticket number; no new runtime path-tell mechanism.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RoleTurnHost, RoleTurnRequest } from "../../src/host-contracts.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { seedCanonicalSourceRun } from "../helpers/notary-fixtures.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

const TICKET = 1092;

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "no-dossier@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "No Dossier Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

function caseDossierPointerMaterials(
  materials: readonly unknown[],
): readonly unknown[] {
  return materials.filter(
    (material) =>
      typeof material === "object"
      && material !== null
      && (material as { kind?: unknown }).kind === "case-dossier-pointer",
  );
}

async function assertNoCaseDossierAttachment(runDirectory: string): Promise<void> {
  await assert.rejects(
    () => access(join(runDirectory, "attachments", "case-dossier")),
    (error: unknown) =>
      error instanceof Error
      && (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  const attachmentsRoot = join(runDirectory, "attachments");
  try {
    const entries = await readdir(attachmentsRoot);
    assert.equal(
      entries.includes("case-dossier"),
      false,
      `run attachments must not include case-dossier: ${entries.join(",")}`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

test("#1092 bound public entry freezes no case-dossier attachment and folds no pointer material", async () => {
  await withTempRoot("ak-1092-bound-no-dossier-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await seedCanonicalSourceRun(home, project, { ticketNumber: TICKET });
    let seen: RoleTurnRequest | undefined;
    const host: RoleTurnHost = {
      async executeTurn(request: RoleTurnRequest) {
        seen = request;
        return { code: 0, stderr: "", timedOut: false };
      },
    };
    const result = await runAkRole(
      ["judge", "--model", "test/caller-seat:high", "--project", project, "bound summons"],
      {
        home,
        packageRoot,
        cwd: project,
        boundTicketNumber: TICKET,
        roleTurnHost: host,
        createRunId: () => "01a010920000700080000000000001",
      },
    );
    assert.equal(result.exitCode, 0);
    assert.ok(seen, "bound public entry must dispatch a turn");
    await assertNoCaseDossierAttachment(seen.runDirectory);
    assert.ok(
      seen.runDirectory.includes(`${join(String(TICKET), "runs")}`),
      `bound run must stay under ticket: ${seen.runDirectory}`,
    );

    const socketDir = await mkdtemp(join(tmpdir(), "ak-1092-bound-env-"));
    const prepared = await prepareRoleEnvelope({
      request: {
        principal: fixturePrincipal(join(seen.runDirectory, "session")),
        activation: { role: "judge" },
        methods: [],
        continuation: { kind: "initial", prompt: "bound summons" },
        cwd: project,
        home,
        agentDir: join(home, "agent"),
        runDirectory: seen.runDirectory,
      },
      dependencies: createRoleRuntimeDependencies(packageRoot),
      socketPath: join(socketDir, "mcp.sock"),
    });
    try {
      assert.equal(caseDossierPointerMaterials(prepared.systemPrompt.materials).length, 0);
      assert.equal(prepared.prompt, "bound summons");
    } finally {
      await prepared.dispose?.();
    }
  });
});

test("#1092 unbound public entry freezes no case-dossier attachment and folds no pointer material", async () => {
  await withTempRoot("ak-1092-unbound-no-dossier-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    let seen: RoleTurnRequest | undefined;
    const host: RoleTurnHost = {
      async executeTurn(request: RoleTurnRequest) {
        seen = request;
        return { code: 0, stderr: "", timedOut: false };
      },
    };
    const result = await runAkRole(
      ["judge", "--model", "test/caller-seat:high", "--project", project, "unbound summons"],
      {
        home,
        packageRoot,
        cwd: project,
        roleTurnHost: host,
        createRunId: () => "01a010920000700080000000000002",
      },
    );
    assert.equal(result.exitCode, 0);
    assert.ok(seen, "unbound public entry must dispatch a turn");
    await assertNoCaseDossierAttachment(seen.runDirectory);
    assert.ok(
      seen.runDirectory.includes(`${join("unbound", "runs")}`),
      `unbound run must stay under unbound: ${seen.runDirectory}`,
    );

    const socketDir = await mkdtemp(join(tmpdir(), "ak-1092-unbound-env-"));
    const prepared = await prepareRoleEnvelope({
      request: {
        principal: fixturePrincipal(join(seen.runDirectory, "session")),
        activation: { role: "judge" },
        methods: [],
        continuation: { kind: "initial", prompt: "unbound summons" },
        cwd: project,
        home,
        agentDir: join(home, "agent"),
        runDirectory: seen.runDirectory,
      },
      dependencies: createRoleRuntimeDependencies(packageRoot),
      socketPath: join(socketDir, "mcp.sock"),
    });
    try {
      assert.equal(caseDossierPointerMaterials(prepared.systemPrompt.materials).length, 0);
      assert.equal(prepared.prompt, "unbound summons");
    } finally {
      await prepared.dispose?.();
    }
  });
});
