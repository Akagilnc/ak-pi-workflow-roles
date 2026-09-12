/**
 * #879: fresh inspector gate keeps parent binding on activation/material,
 * not in the peer dialogue body.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdmittedInspectorInvocation } from "../../src/public-cli/invocation.ts";
import { buildInspectorTurnRequest } from "../../src/public-cli/inspector-run.ts";
import { projectActivationFlags } from "../../src/role-activation-flags.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

const PARENT = "/tmp/ak-879-parent-run";
const PAYLOAD = { status: "completed", report: "inspector-peer-body" };

function admittedInspector(instruction: string): AdmittedInspectorInvocation {
  const runDirectory = "/tmp/ak-879-inspector-run";
  return {
    role: "inspector",
    runId: "run-inspector",
    bookKey: "book",
    projectRoot: "/tmp/proj",
    instruction,
    instructionEmpty: false,
    attachments: [],
    runDirectory,
    principal: fixturePrincipal(join(runDirectory, "session")),
    admittedRequestPath: join(runDirectory, "admitted-request.json"),
  };
}

test("#879 inspector first mint: parent path on activation, payload stays dialogue", () => {
  const request = buildInspectorTurnRequest(
    admittedInspector(`卷宗指针：${PARENT}`),
    {
      packageRoot,
      home: "/tmp/home",
      agentDir: "/tmp/agent",
      continuation: { kind: "initial", prompt: JSON.stringify(PAYLOAD) },
    },
  );
  assert.equal(request.activation.role, "inspector");
  assert.equal(
    request.activation.role === "inspector" ? request.activation.sourceRun : undefined,
    PARENT,
  );
  assert.equal(request.continuation.prompt, JSON.stringify(PAYLOAD));
  assert.equal(request.continuation.prompt.includes(PARENT), false);
  const flags = projectActivationFlags(request);
  assert.equal(flags.get("ak-inspector-source-run"), PARENT);
});

test("#879 inspector parent binding rides readingMaterial, not prompt", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-879-inspector-bind-"));
  const runDirectory = join(home, "run");
  await mkdir(join(runDirectory, "session"), { recursive: true });
  const request = buildInspectorTurnRequest(
    {
      ...admittedInspector(`卷宗指针：${PARENT}`),
      projectRoot: packageRoot,
      runDirectory,
      principal: fixturePrincipal(join(runDirectory, "session")),
    },
    {
      packageRoot,
      home,
      agentDir: join(home, "agent"),
      continuation: { kind: "initial", prompt: JSON.stringify(PAYLOAD) },
    },
  );
  const prepared = await prepareRoleEnvelope({
    request,
    dependencies: createRoleRuntimeDependencies(packageRoot),
    socketPath: join(home, "mcp.sock"),
  });
  try {
    assert.equal(prepared.prompt, JSON.stringify(PAYLOAD));
    const bindings = prepared.systemPrompt.materials.filter(
      (material) =>
        typeof material === "object"
        && material !== null
        && (material as { kind?: unknown }).kind === "inspector-parent-binding",
    );
    assert.equal(bindings.length, 1);
    assert.deepEqual(bindings[0], {
      kind: "inspector-parent-binding",
      sourceRunPath: PARENT,
    });
  } finally {
    await prepared.dispose?.();
    await rm(home, { recursive: true, force: true });
  }
});
