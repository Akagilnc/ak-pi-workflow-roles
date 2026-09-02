import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { projectHostTransitionPriorNative } from "../../src/host-transition-prior-native.ts";

test("unknown previous or live host yields no hostTransition (no inject)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-host-transition-unknown-"));
  try {
    const runDirectory = join(root, "run");
    const piSessionFile = join(runDirectory, "session", "session.jsonl");
    await mkdir(join(runDirectory, "session"), { recursive: true });
    await writeFile(piSessionFile, `${JSON.stringify({ type: "session", id: "s" })}\n`, "utf8");

    assert.equal(
      await projectHostTransitionPriorNative({
        previousHost: "third-adapter",
        liveHost: "grok-build",
        runDirectory,
        piSessionFile,
      }),
      undefined,
    );
    assert.equal(
      await projectHostTransitionPriorNative({
        previousHost: "pi",
        liveHost: "third-adapter",
        runDirectory,
        piSessionFile,
      }),
      undefined,
    );
    assert.equal(
      await projectHostTransitionPriorNative({
        previousHost: "pi",
        liveHost: "pi",
        runDirectory,
        piSessionFile,
      }),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("known pi→grok-build projects priorNativeRecords from pi session file", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-host-transition-pi-"));
  try {
    const runDirectory = join(root, "run");
    const piSessionFile = join(runDirectory, "session", "host-issued.jsonl");
    await mkdir(join(runDirectory, "session"), { recursive: true });
    const bytes = `${JSON.stringify({ type: "session", id: "s" })}\n${JSON.stringify({ type: "message", id: "m" })}\n`;
    await writeFile(piSessionFile, bytes, "utf8");

    const transition = await projectHostTransitionPriorNative({
      previousHost: "pi",
      liveHost: "grok-build",
      runDirectory,
      piSessionFile,
    });
    assert.deepEqual(transition, {
      previousHost: "pi",
      priorNativeRecords: bytes.trim(),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
