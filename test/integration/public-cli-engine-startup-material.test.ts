/**
 * #1167 — outsourcing coordinates ride startup materials (handbook bodies),
 * never the transport prompt / auto-resume continuation.
 * Seam: public `ak-role` + fake host that runs prepareRoleEnvelope and records
 * the prompt + systemPrompt.materials the seat would see.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { RESUME_TRANSPORT_ENVELOPE } from "../../src/public-cli/run-lifecycle.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { seedCanonicalSourceRun } from "../helpers/notary-fixtures.ts";
import { packageRoot, withHermeticHome } from "../helpers/pi-test-harness.ts";
import { createMinimalHost } from "../helpers/role-turn-host-fixture.ts";
import { withPassingReviewHost } from "../helpers/passing-review-host.ts";

const ENGINE = "cursor";
const ENGINE_MODEL = "cursor-grok-4.6-high";
const DISPATCH_INSTRUCTION = "fix the packet under review";
const SEAT_MODEL = "test/caller-seat:high";

async function seedFixerSeat(home: string, engine?: { name: string; model?: string }): Promise<void> {
  const { io } = captureIo();
  const setModel = await runAkRole(
    ["config", "set", "fixer", SEAT_MODEL],
    { packageRoot, home, io },
  );
  assert.equal(setModel.exitCode, 0, "config set fixer must succeed");
  if (engine === undefined) return;
  const args = ["config", "set-engine", "fixer", engine.name];
  if (engine.model !== undefined) args.push(engine.model);
  const setEngine = await runAkRole(args, { packageRoot, home, io: captureIo().io });
  assert.equal(setEngine.exitCode, 0, `set-engine ${engine.name} must succeed`);
}

async function seedNotarySeat(home: string, engine: { name: string; model?: string }): Promise<void> {
  const { io } = captureIo();
  const setModel = await runAkRole(
    ["config", "set", "notary", SEAT_MODEL],
    { packageRoot, home, io },
  );
  assert.equal(setModel.exitCode, 0, "config set notary must succeed");
  const args = ["config", "set-engine", "notary", engine.name];
  if (engine.model !== undefined) args.push(engine.model);
  const setEngine = await runAkRole(args, { packageRoot, home, io: captureIo().io });
  assert.equal(setEngine.exitCode, 0, `set-engine notary ${engine.name} must succeed`);
}

type CapturedTurn = {
  readonly prompt: string;
  readonly materials: readonly unknown[];
  readonly engine?: string;
};

function engineSessionMaterials(materials: readonly unknown[]): readonly Record<string, unknown>[] {
  return materials.filter((material): material is Record<string, unknown> =>
    typeof material === "object"
    && material !== null
    && (material as { kind?: unknown }).kind === "engine-session-material",
  );
}

async function capturePreparedTurn(
  execute: (request: Parameters<Parameters<typeof createMinimalHost>[0]>[0]) => Promise<CapturedTurn>,
) {
  let captured: CapturedTurn | undefined;
  const host = withPassingReviewHost(createMinimalHost(async (request) => {
    // Keep the first dispatch only — host exit 1 may auto-resume and overwrite.
    if (captured === undefined) {
      captured = await execute(request);
    }
    return { code: 1, stderr: "stop after capture", timedOut: false };
  }));
  return {
    host,
    get captured() {
      assert.ok(captured !== undefined, "fake host did not capture a turn");
      return captured;
    },
  };
}

async function prepareAndCapture(
  request: Parameters<Parameters<typeof createMinimalHost>[0]>[0],
): Promise<CapturedTurn> {
  const prepared = await prepareRoleEnvelope({
    request: { ...request, host: request.host ?? "codex" },
    dependencies: createRoleRuntimeDependencies(packageRoot),
    socketPath: `/tmp/ak-1167-${randomUUID()}.sock`,
    sessionFile: piDurablePrincipalAuthority.decode(request.principal).sessionFile,
  });
  try {
    return {
      prompt: prepared.prompt,
      materials: prepared.systemPrompt.materials,
      ...(request.engine === undefined ? {} : { engine: request.engine }),
    };
  } finally {
    await prepared.dispose?.();
  }
}

test("#1167 fixer with engine: prompt stays dispatch-only; startup carries handbook bodies", async () => {
  await withHermeticHome({ prefix: "ak-1167-fixer-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await seedFixerSeat(home, { name: ENGINE, model: ENGINE_MODEL });
    const handbook = await readFile(join(packageRoot, "resources/engines/cursor.md"), "utf8");
    const dispatch = await readFile(join(packageRoot, "resources/engine-dispatch.md"), "utf8");
    const probe = await capturePreparedTurn(prepareAndCapture);
    const { io } = captureIo();
    await runAkRole(
      ["fixer", "--model", SEAT_MODEL, "--project", project, DISPATCH_INSTRUCTION],
      {
        packageRoot,
        home,
        cwd: project,
        io,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-1167-fixer-engine",
        principalAuthority: piDurablePrincipalAuthority,
        roleTurnHost: probe.host,
      },
    );
    const { prompt, materials } = probe.captured;
    assert.equal(prompt, DISPATCH_INSTRUCTION);
    assert.equal(prompt.includes(handbook), false);
    assert.equal(prompt.includes(dispatch), false);
    const engines = engineSessionMaterials(materials);
    assert.equal(engines.length, 1);
    assert.equal(engines[0]?.name, ENGINE);
    assert.equal(engines[0]?.model, ENGINE_MODEL);
    assert.equal(engines[0]?.handbook, handbook);
    assert.equal(engines[0]?.dispatchHandbook, dispatch);
    assert.equal("materialPath" in (engines[0] ?? {}), false);
  });
});

test("#1167 --engine overrides persistent seat engine in startup materials", async () => {
  await withHermeticHome({ prefix: "ak-1167-override-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await seedFixerSeat(home, { name: "agy" });
    const probe = await capturePreparedTurn(prepareAndCapture);
    const { io } = captureIo();
    await runAkRole(
      [
        "--engine",
        ENGINE,
        "fixer",
        "--model",
        SEAT_MODEL,
        "--project",
        project,
        DISPATCH_INSTRUCTION,
      ],
      {
        packageRoot,
        home,
        cwd: project,
        io,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-1167-engine-override",
        principalAuthority: piDurablePrincipalAuthority,
        roleTurnHost: probe.host,
      },
    );
    const engines = engineSessionMaterials(probe.captured.materials);
    assert.equal(engines.length, 1);
    assert.equal(engines[0]?.name, ENGINE);
    assert.equal(probe.captured.engine, ENGINE);
  });
});

test("#1167 engine-free seat: startup materials have no outsourcing segment", async () => {
  await withHermeticHome({ prefix: "ak-1167-free-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await seedFixerSeat(home);
    const probe = await capturePreparedTurn(prepareAndCapture);
    const { io } = captureIo();
    await runAkRole(
      ["fixer", "--model", SEAT_MODEL, "--project", project, DISPATCH_INSTRUCTION],
      {
        packageRoot,
        home,
        cwd: project,
        io,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-1167-engine-free",
        principalAuthority: piDurablePrincipalAuthority,
        roleTurnHost: probe.host,
      },
    );
    assert.equal(probe.captured.prompt, DISPATCH_INSTRUCTION);
    assert.equal(engineSessionMaterials(probe.captured.materials).length, 0);
  });
});

test("#1167 auto-resume: continuation stays envelope-only; startup still carries engine", async () => {
  await withHermeticHome({ prefix: "ak-1167-auto-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await seedFixerSeat(home);
    {
      const { io } = captureIo();
      await runAkRole(["config", "set-auto-resume-limit", "2"], { packageRoot, home, io });
    }
    const handbook = await readFile(join(packageRoot, "resources/engines/cursor.md"), "utf8");
    const turns: CapturedTurn[] = [];
    let first = true;
    const host = withPassingReviewHost(createMinimalHost(async (request) => {
      const prepared = await prepareAndCapture(request);
      turns.push(prepared);
      if (first) {
        first = false;
        const { sessionDirectory, sessionFile } = piDurablePrincipalAuthority.decode(request.principal);
        await mkdir(sessionDirectory, { recursive: true });
        await writeFile(sessionFile, "", "utf8");
        return { code: 1, stderr: "quota", timedOut: false };
      }
      return { code: 1, stderr: "stop after auto-resume capture", timedOut: false };
    }));
    const { io } = captureIo();
    await runAkRole(
      [
        "fixer",
        "--model",
        SEAT_MODEL,
        "--project",
        project,
        "--engine",
        ENGINE,
        DISPATCH_INSTRUCTION,
      ],
      {
        packageRoot,
        home,
        cwd: project,
        io,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-1167-auto-resume",
        principalAuthority: piDurablePrincipalAuthority,
        roleTurnHost: host,
      },
    );
    assert.ok(turns.length >= 2, "auto-resume must re-dispatch");
    assert.equal(turns[0]?.prompt, DISPATCH_INSTRUCTION);
    assert.equal(turns[1]?.prompt, RESUME_TRANSPORT_ENVELOPE);
    assert.equal(turns[1]?.prompt.includes(handbook), false);
    for (const turn of turns) {
      const engines = engineSessionMaterials(turn.materials);
      assert.equal(engines.length, 1);
      assert.equal(engines[0]?.name, ENGINE);
      assert.equal(engines[0]?.handbook, handbook);
    }
  });
});

test("#1167 name-only engine: startup carries name/model only", async () => {
  await withHermeticHome({ prefix: "ak-1167-nameonly-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await seedFixerSeat(home);
    const probe = await capturePreparedTurn(prepareAndCapture);
    const { io } = captureIo();
    await runAkRole(
      [
        "fixer",
        "--model",
        SEAT_MODEL,
        "--project",
        project,
        "--engine",
        "ghost-engine",
        DISPATCH_INSTRUCTION,
      ],
      {
        packageRoot,
        home,
        cwd: project,
        io,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-1167-name-only",
        principalAuthority: piDurablePrincipalAuthority,
        roleTurnHost: probe.host,
      },
    );
    assert.equal(probe.captured.prompt, DISPATCH_INSTRUCTION);
    const engines = engineSessionMaterials(probe.captured.materials);
    assert.equal(engines.length, 1);
    assert.deepEqual(engines[0], {
      kind: "engine-session-material",
      name: "ghost-engine",
    });
  });
});

test("#1167 officer seat with engine: same startup delivery as worker seats", async () => {
  await withHermeticHome({ prefix: "ak-1167-officer-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRun = await seedCanonicalSourceRun(home, project);
    await seedNotarySeat(home, { name: ENGINE, model: ENGINE_MODEL });
    const handbook = await readFile(join(packageRoot, "resources/engines/cursor.md"), "utf8");
    const dispatch = await readFile(join(packageRoot, "resources/engine-dispatch.md"), "utf8");
    // Do not wrap withPassingReviewHost — notary is an officer seat and would
    // be swallowed by the converging scripted reviewer host.
    let captured: CapturedTurn | undefined;
    const host = createMinimalHost(async (request) => {
      if (captured === undefined) {
        captured = await prepareAndCapture(request);
      }
      return { code: 1, stderr: "stop after capture", timedOut: false };
    });
    const { io } = captureIo();
    await runAkRole(
      ["notary", "--model", SEAT_MODEL, "--source-run", sourceRun],
      {
        packageRoot,
        home,
        cwd: project,
        io,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-1167-notary-engine",
        principalAuthority: piDurablePrincipalAuthority,
        roleTurnHost: host,
      },
    );
    assert.ok(captured !== undefined, "fake host did not capture a turn");
    const engines = engineSessionMaterials(captured.materials);
    assert.equal(engines.length, 1);
    assert.equal(engines[0]?.name, ENGINE);
    assert.equal(engines[0]?.model, ENGINE_MODEL);
    assert.equal(engines[0]?.handbook, handbook);
    assert.equal(engines[0]?.dispatchHandbook, dispatch);
    assert.equal(captured.prompt.includes(handbook), false);
  });
});
