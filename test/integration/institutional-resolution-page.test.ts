import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  INSTITUTIONAL_RESOLUTION_FILE,
  readInstitutionalSeatSelection,
  writeInstitutionalResolutionPage,
  InstitutionalResolutionError,
  type InstitutionalResolutionPage,
} from "../../src/institutional-resolution.ts";

test("resolution page write, read, missing-seat, resume rewrite, and corruption failures", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "ak-test-resolution-page-"));
  try {
    const pageV1: InstitutionalResolutionPage = {
      version: 1,
      seats: {
        gatekeeper: { provider: "prov-1", model: "mod-1" },
        inspector: { provider: "prov-1", model: "mod-1" },
        notary: { provider: "prov-1", model: "mod-1" },
      },
    };

    // 1. Write and read
    await writeInstitutionalResolutionPage(runDir, pageV1);
    const readGatekeeper = await readInstitutionalSeatSelection(runDir, "gatekeeper");
    assert.deepEqual(readGatekeeper, { provider: "prov-1", model: "mod-1" });

    // 2. Missing seat in existing page throws typed error
    await assert.rejects(
      () => readInstitutionalSeatSelection(runDir, "auditor"),
      (error) => {
        assert.ok(error instanceof InstitutionalResolutionError);
        return true;
      },
    );

    // 3. Resume rewrite updates page
    const pageV2: InstitutionalResolutionPage = {
      version: 1,
      seats: {
        gatekeeper: { provider: "prov-2", model: "mod-2", thinking: "high" },
        inspector: { provider: "prov-2", model: "mod-2", thinking: "high" },
        notary: { provider: "prov-2", model: "mod-2", thinking: "high" },
        auditor: { provider: "prov-2", model: "mod-2", thinking: "high" },
      },
    };
    await writeInstitutionalResolutionPage(runDir, pageV2);
    const readAfterResume = await readInstitutionalSeatSelection(runDir, "gatekeeper");
    assert.deepEqual(readAfterResume, { provider: "prov-2", model: "mod-2", thinking: "high" });

    // 4. Corrupted page throws typed error
    await writeFile(join(runDir, INSTITUTIONAL_RESOLUTION_FILE), "not valid json {{{{", "utf8");
    await assert.rejects(
      () => readInstitutionalSeatSelection(runDir, "gatekeeper"),
      (error) => {
        assert.ok(error instanceof InstitutionalResolutionError);
        return true;
      },
    );

    // 5. Missing runDir / missing page throws typed error
    const missingRunDir = join(runDir, "does-not-exist");
    await assert.rejects(
      () => readInstitutionalSeatSelection(missingRunDir, "gatekeeper"),
      (error) => {
        assert.ok(error instanceof InstitutionalResolutionError);
        return true;
      },
    );
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("recordEffectiveInvocationModel recovers effective model from invocation truth source on resume/refresh", async () => {
  const { recordEffectiveInvocationModel } = await import("../../src/public-cli/invocation.ts");
  const { withActivationHome } = await import("../helpers/pi-test-harness.ts");
  await withActivationHome({ prefix: "ak-test-invocation-truth-" }, async ({ home }) => {
    const runDir = join(home, "run");
    await (await import("node:fs/promises")).mkdir(runDir, { recursive: true });

    // Initial invocation identity written with effective model
    const initialLedger = {
      role: "coder",
      runId: "0195-test-run",
      bookKey: "test-book",
      projectRoot: home,
      runDirectory: runDir,
      sessionDirectory: join(runDir, "session"),
      sessionFile: join(runDir, "session", "session.jsonl"),
      provider: "initial-provider",
      model: "initial-model",
      thinking: "high",
    };
    await writeFile(join(runDir, "invocation.json"), JSON.stringify(initialLedger, null, 2), "utf8");

    // 1. Calling recordEffectiveInvocationModel without model (e.g. engine update on resume)
    await recordEffectiveInvocationModel(runDir, undefined, "next-engine");

    // Institutional resolution page must recover parent effective model from invocation.json
    const gatekeeperSeat = await readInstitutionalSeatSelection(runDir, "gatekeeper");
    assert.deepEqual(gatekeeperSeat, {
      provider: "initial-provider",
      model: "initial-model",
      thinking: "high",
    });

    // Auditor and evidenceChild must also inherit recovered parent effective model
    const auditorSeat = await readInstitutionalSeatSelection(runDir, "auditor");
    assert.deepEqual(auditorSeat, {
      provider: "initial-provider",
      model: "initial-model",
      thinking: "high",
    });

    // 2. Calling recordEffectiveInvocationModel with new model (override)
    await recordEffectiveInvocationModel(runDir, {
      provider: "resume-provider",
      model: "resume-model",
    });

    const updatedGatekeeper = await readInstitutionalSeatSelection(runDir, "gatekeeper");
    assert.deepEqual(updatedGatekeeper, {
      provider: "resume-provider",
      model: "resume-model",
    });
  });
});
