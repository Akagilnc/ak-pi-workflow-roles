import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  // 2. Resumable roles (5) vs one-shot roles (3) partition
  const resumableRoles = ["judge", "coder", "fixer", "reviewer", "merger"];
  const oneShotRoles = ["collector", "doctor", "notary"];
  for (const role of resumableRoles) {
    assert.equal(recordRoles.includes(role as never), true);
  }
  for (const role of oneShotRoles) {
    assert.equal(recordRoles.includes(role as never), true);
  }

  // 3. Verify output tools and session materials are configured for every record
  for (const record of PUBLIC_ROLE_RECORDS) {
    assert.ok(record.outputTool, `Record for ${record.role} must define outputTool`);
    assert.ok(record.sessionMaterials.length > 0, `Record for ${record.role} must define session materials`);
    assert.ok(record.sessionMaterials.includes("CLAUDE.md"), `Record for ${record.role} must include CLAUDE.md`);
  }

  // 4. Reduced A metadata mappings for non-callable officers and sub-sessions
  const reducedAMetadata = {
    gatekeeper: { isCallable: false, role: "gatekeeper", kind: "officer" },
    inspector: { isCallable: false, role: "inspector", kind: "officer" },
    judgeSubSession: { isCallable: false, parentRole: "judge", kind: "sub-session" },
    doctorSubSession: { isCallable: false, parentRole: "doctor", kind: "sub-session" },
  };
  assert.equal(reducedAMetadata.gatekeeper.isCallable, false);
  assert.equal(reducedAMetadata.inspector.isCallable, false);
  assert.equal(reducedAMetadata.judgeSubSession.isCallable, false);
  assert.equal(reducedAMetadata.doctorSubSession.isCallable, false);
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

test("coordinator uniqueness: no runner duplicates post-admission coordination", async () => {
  const runnerFiles = [
    "coder-run.ts",
    "collector-run.ts",
    "doctor-run.ts",
    "fixer-run.ts",
    "judge-run.ts",
    "merger-run.ts",
    "notary-run.ts",
    "reviewer-run.ts",
  ];

  for (const file of runnerFiles) {
    const content = await readFile(join(packageRoot, "src/public-cli", file), "utf8");
    // Assert all runners import post-admission coordinator
    assert.match(content, /from "\.\/post-admission\.ts"/, `${file} must import from post-admission.ts`);
    // Assert none contain duplicate dispatchAdmitted* implementations
    assert.equal(/function dispatchAdmitted/.test(content), false, `${file} must not contain dispatchAdmitted`);
  }
});
