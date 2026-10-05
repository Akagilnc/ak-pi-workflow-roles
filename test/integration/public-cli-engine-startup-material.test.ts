/**
 * #1167 — outsourcing rides startup materials (handbook bodies), never the
 * transport prompt. Auto-resume envelope-only + material retention lives on the
 * existing public-cli-engine-resume-detour seam (no parallel resume fixture).
 * Seam: public `ak-role` + fake host that records prepareRoleEnvelope output.
 * Gate-summoned review reuses withPassingReviewHost + sealAcceptedSubmission
 * (#1132 public-entry gate observability), not a direct officer public call.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { RoleTurnHost, RoleTurnRequest } from "../../src/host-contracts.ts";
import { packagedExternalHostNames } from "../../src/host-descriptions.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { runIdFromRunDirectory } from "../../src/run-terminal-artifacts.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import {
  configurePassingReviewSeats,
  seedPublicSeat,
  withPassingReviewHost,
} from "../helpers/passing-review-host.ts";
import { packageRoot, withHermeticHome } from "../helpers/pi-test-harness.ts";
import {
  capturePreparedEnvelope,
  createMinimalHost,
} from "../helpers/role-turn-host-fixture.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";

const ENGINE = "cursor";
const ENGINE_MODEL = "cursor-grok-4.6-high";
const GHOST_ENGINE = "ghost-engine";
const GHOST_MODEL = "ghost-model-x";
const DISPATCH = "fix the packet under review";
const SEAT = "test/caller-seat:high";
const CREDS = { "openai-codex": true, xai: true } as const;

type Captured = Awaited<ReturnType<typeof capturePreparedEnvelope>>;

function engineMaterials(materials: readonly unknown[]): readonly Record<string, unknown>[] {
  return materials.filter((material): material is Record<string, unknown> =>
    typeof material === "object"
    && material !== null
    && (material as { kind?: unknown }).kind === "engine-session-material",
  );
}

function firstCaptureHost(
  onCapture: (request: RoleTurnRequest) => Promise<Captured>,
): { host: RoleTurnHost; get(): Captured } {
  let captured: Captured | undefined;
  const host = withPassingReviewHost(createMinimalHost(async (request) => {
    if (captured === undefined) captured = await onCapture(request);
    return { code: 1, stderr: "stop after capture", timedOut: false };
  }));
  return {
    host,
    get() {
      assert.ok(captured !== undefined, "fake host did not capture a turn");
      return captured;
    },
  };
}

async function runFixer(
  home: string,
  project: string,
  host: RoleTurnHost,
  runId: string,
  argv: readonly string[],
): Promise<void> {
  await runAkRole(argv, {
    packageRoot,
    home,
    cwd: project,
    io: captureIo().io,
    credentials: CREDS,
    createRunId: () => runId,
    principalAuthority: piDurablePrincipalAuthority,
    roleTurnHost: host,
  });
}

test("#1167 public fixer: prompt dispatch-only; startup materials by engine shape", async () => {
  await withHermeticHome({ prefix: "ak-1167-fixer-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const handbook = await readFile(join(packageRoot, "resources/engines/cursor.md"), "utf8");
    const dispatch = await readFile(join(packageRoot, "resources/engine-dispatch.md"), "utf8");

    // With packaged handbook: name/model + handbook bodies; no materialPath.
    await seedPublicSeat(home, "fixer", { name: ENGINE, model: ENGINE_MODEL });
    {
      const probe = firstCaptureHost(capturePreparedEnvelope);
      await runFixer(home, project, probe.host, "run-1167-with-engine", [
        "fixer", "--model", SEAT, "--project", project, DISPATCH,
      ]);
      assert.equal(probe.get().prompt, DISPATCH);
      const engines = engineMaterials(probe.get().materials);
      assert.equal(engines.length, 1);
      assert.deepEqual(engines[0], {
        kind: "engine-session-material",
        name: ENGINE,
        model: ENGINE_MODEL,
        handbook,
        dispatchHandbook: dispatch,
      });
    }

    // Per-call --engine overrides persistent seat engine.
    await seedPublicSeat(home, "fixer", { name: "agy" });
    {
      const probe = firstCaptureHost(capturePreparedEnvelope);
      await runFixer(home, project, probe.host, "run-1167-override", [
        "--engine", ENGINE, "fixer", "--model", SEAT, "--project", project, DISPATCH,
      ]);
      const engines = engineMaterials(probe.get().materials);
      assert.equal(engines.length, 1);
      assert.equal(engines[0]?.name, ENGINE);
      assert.equal(probe.get().engine, ENGINE);
    }

    // No handbook engine with model: only name/model.
    await seedPublicSeat(home, "fixer", { name: GHOST_ENGINE, model: GHOST_MODEL });
    {
      const probe = firstCaptureHost(capturePreparedEnvelope);
      await runFixer(home, project, probe.host, "run-1167-name-model", [
        "fixer", "--model", SEAT, "--project", project, DISPATCH,
      ]);
      assert.equal(probe.get().prompt, DISPATCH);
      assert.deepEqual(engineMaterials(probe.get().materials), [{
        kind: "engine-session-material",
        name: GHOST_ENGINE,
        model: GHOST_MODEL,
      }]);
    }

    // Engine-free: no outsourcing segment (clear by re-seeding without engine).
    {
      const { io } = captureIo();
      assert.equal(
        (await runAkRole(["config", "unset-engine", "fixer"], { packageRoot, home, io })).exitCode,
        0,
      );
      const probe = firstCaptureHost(capturePreparedEnvelope);
      await runFixer(home, project, probe.host, "run-1167-engine-free", [
        "fixer", "--model", SEAT, "--project", project, DISPATCH,
      ]);
      assert.equal(probe.get().prompt, DISPATCH);
      assert.equal(engineMaterials(probe.get().materials).length, 0);
    }
  });
});

test("#1167 gate-summoned review seat: same startup delivery as worker seats", async () => {
  await withHermeticHome({ prefix: "ak-1167-gate-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await seedPublicSeat(home, "judge");
    await configurePassingReviewSeats(home);
    // Outfit every review seat — gate may summon auditor / inspector / notary.
    for (const role of ["auditor", "inspector", "notary"] as const) {
      await seedPublicSeat(home, role, { name: ENGINE, model: ENGINE_MODEL });
    }
    const handbook = await readFile(join(packageRoot, "resources/engines/cursor.md"), "utf8");
    const dispatch = await readFile(join(packageRoot, "resources/engine-dispatch.md"), "utf8");
    let officer: Captured | undefined;
    const seatsDispatched: string[] = [];
    const judgeHost: RoleTurnHost = {
      async executeTurn(request) {
        if (request.activation.role !== "judge") {
          return { code: 0, stderr: "", timedOut: false };
        }
        const coordinates = piDurablePrincipalAuthority.decode(request.principal);
        await mkdir(coordinates.sessionDirectory, { recursive: true });
        await writeFile(
          coordinates.sessionFile,
          `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } })}\n`,
          "utf8",
        );
        await sealAcceptedSubmission({
          cwd: request.cwd,
          runId: runIdFromRunDirectory(request.runDirectory)!,
          runDirectory: request.runDirectory,
          role: "judge",
          details: { status: "converged" },
          toolCallId: "judge-1167-seal",
          home: request.home,
        });
        return { code: 0, stderr: "", timedOut: false };
      },
    };
    const reviewing = withPassingReviewHost(judgeHost);
    const host: RoleTurnHost = {
      async executeTurn(request) {
        seatsDispatched.push(request.activation.role);
        if (
          officer === undefined
          && request.stationChild === true
          && (request.activation.role === "auditor"
            || request.activation.role === "inspector"
            || request.activation.role === "notary")
        ) {
          officer = await capturePreparedEnvelope(request);
        }
        return reviewing.executeTurn(request);
      },
    };
    const result = await runAkRole(
      ["judge", "--host", "grok-build", "--model", SEAT, "--project", project, "go"],
      {
        packageRoot,
        home,
        cwd: project,
        io: captureIo().io,
        credentials: CREDS,
        createRunId: () => "run-1167-gate-officer",
        principalAuthority: piDurablePrincipalAuthority,
        roleTurnHost: host,
        hostAdapters: packagedExternalHostNames()
          .concat("pi")
          .map((name) => ({ name, create: () => ({ ok: true as const, host }) })),
      },
    );
    assert.equal(result.exitCode, 0, "judge public entry must settle");
    assert.ok(
      seatsDispatched.some((role) => role !== "judge"),
      `gate must summon a review seat; seats=${JSON.stringify(seatsDispatched)}`,
    );
    assert.ok(officer !== undefined, "gate-summoned officer turn was not observed");
    assert.equal(officer.stationChild, true, "officer must be station-child (gate summons)");
    assert.notEqual(officer.role, "judge");
    const engines = engineMaterials(officer.materials);
    assert.equal(engines.length, 1);
    assert.deepEqual(engines[0], {
      kind: "engine-session-material",
      name: ENGINE,
      model: ENGINE_MODEL,
      handbook,
      dispatchHandbook: dispatch,
    });
  });
});
