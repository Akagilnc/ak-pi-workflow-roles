/**
 * #879: first-mint officer gate payload stays dialogue; engine coordinates
 * ride the existing readingMaterial face.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RoleTurnActivation, RoleTurnRequest } from "../../src/host-contracts.ts";
import { resolveEngineMaterialPath } from "../../src/package-resources/engine-material.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { seedCanonicalSourceRun } from "../helpers/notary-fixtures.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

const PAYLOAD = { status: "completed", report: "officer-peer-body" };
const ENGINE = "cursor";
const ENGINE_MODEL = "cursor-grok-4.6-high-fast";

function officerRequest(
  home: string,
  runDirectory: string,
  activation: RoleTurnActivation,
): RoleTurnRequest {
  return {
    principal: fixturePrincipal(join(runDirectory, "session")),
    activation,
    methods: [],
    continuation: { kind: "initial", prompt: JSON.stringify(PAYLOAD) },
    engine: ENGINE,
    engineModel: ENGINE_MODEL,
    cwd: packageRoot,
    home,
    agentDir: join(runDirectory, "agent"),
    runDirectory,
  };
}

test("#879 first-mint officer engine material stays off dialogue", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-879-officer-engine-"));
  const notesPath = resolveEngineMaterialPath(packageRoot, ENGINE);
  const parentRun = await seedCanonicalSourceRun(home, packageRoot);
  const seats: readonly RoleTurnActivation[] = [
    { role: "notary", sourceRun: parentRun },
    { role: "inspector", sourceRun: parentRun },
    { role: "auditor" },
  ];
  try {
    for (const activation of seats) {
      const runDirectory = join(home, activation.role, "run");
      await mkdir(join(runDirectory, "session"), { recursive: true });
      const priorSubject = process.env.AK_ROLE_AUDITOR_SUBJECT;
      if (activation.role === "auditor") {
        process.env.AK_ROLE_AUDITOR_SUBJECT = "judge";
      }
      let prepared;
      try {
        prepared = await prepareRoleEnvelope({
          request: officerRequest(home, runDirectory, activation),
          dependencies: createRoleRuntimeDependencies(packageRoot),
          socketPath: join(home, `${activation.role}.sock`),
        });
      } finally {
        if (activation.role === "auditor") {
          if (priorSubject === undefined) delete process.env.AK_ROLE_AUDITOR_SUBJECT;
          else process.env.AK_ROLE_AUDITOR_SUBJECT = priorSubject;
        }
      }
      try {
        assert.equal(prepared.prompt, JSON.stringify(PAYLOAD));
        assert.equal(prepared.prompt.includes(ENGINE), false);
        assert.equal(prepared.prompt.includes(ENGINE_MODEL), false);
        const engines = prepared.systemPrompt.materials.filter(
          (material) =>
            typeof material === "object"
            && material !== null
            && (material as { kind?: unknown }).kind === "engine-session-material",
        );
        assert.equal(engines.length, 1, `${activation.role} must keep engine material`);
        assert.deepEqual(engines[0], {
          kind: "engine-session-material",
          name: ENGINE,
          model: ENGINE_MODEL,
          materialPath: notesPath,
        });
      } finally {
        await prepared.dispose?.();
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
