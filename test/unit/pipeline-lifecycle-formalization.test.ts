import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PUBLIC_ROLE_RECORDS,
  NOTARY_SESSION_MATERIALS,
  type PublicRoleRecord,
} from "../../src/packaged-role-registry.ts";
import { PUBLIC_CALLABLE_ROLES } from "../../src/public-cli/registry.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import type {
  RoleTurnHost,
  RoleTurnRequest,
  RoleTurnResult,
} from "../../src/host-contracts.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

test("acceptance d: 8-role record mapping matrix and reduced A metadata completeness", () => {
  // 1. Packaged registry contains exactly the 8 callable roles
  const recordRoles = PUBLIC_ROLE_RECORDS.map((r) => r.role);
  assert.equal(recordRoles.length, 8);
  for (const role of PUBLIC_CALLABLE_ROLES) {
    assert.equal(recordRoles.includes(role), true, `Role ${role} must be present in PUBLIC_ROLE_RECORDS`);
  }

  // Verify the public record provides each role's structured lifecycle inputs.
  for (const record of PUBLIC_ROLE_RECORDS) {
    assert.ok(record.outputTool, `Record for ${record.role} must define outputTool`);
    assert.ok(record.sessionMaterials.length > 0, `Record for ${record.role} must define session materials`);
    assert.ok(record.sessionMaterials.includes("CLAUDE.md"), `Record for ${record.role} must include CLAUDE.md`);
  }
});

test("acceptance c: host replacement with faux RoleTurnHost through composition root (no Pi dependency)", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-faux-host-test-"));
  try {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: project });
    execFileSync("git", ["config", "user.email", "cli@test.local"], { cwd: project });
    execFileSync("git", ["config", "user.name", "CLI Test"], { cwd: project });
    execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: project });

    let fauxHostCalled = false;
    let receivedRequest: RoleTurnRequest | undefined;

    const fauxHost: RoleTurnHost = {
      async executeTurn(request: RoleTurnRequest): Promise<RoleTurnResult> {
        fauxHostCalled = true;
        receivedRequest = request;
        return {
          code: 0,
          stderr: "faux host stderr output",
          timedOut: false,
        };
      },
    };

    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (t: string) => { stdout.push(t); },
      stderr: (t: string) => { stderr.push(t); },
    };

    const result = await runAkRole(
      ["judge", "--project", project, "arbitrate issue #517"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        roleTurnHost: fauxHost,
        io,
      },
    );

    assert.equal(fauxHostCalled, true, "faux RoleTurnHost must be invoked by composition root");
    assert.equal(receivedRequest?.activation.role, "judge", "faux host must receive typed judge turn request");
    assert.ok(result.terminal !== undefined || result.exitCode !== undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
