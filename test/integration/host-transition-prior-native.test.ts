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
    // Trailing newline retained — exact byte projection must keep it.
    await writeFile(piSessionFile, "{\"type\":\"session\",\"id\":\"s\"}\n", "utf8");

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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grok-build→pi with multiple updates.jsonl delivers all native records deterministically", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-host-transition-multi-grok-"));
  try {
    const runDirectory = join(root, "run");
    const a = join(runDirectory, "grok-home", "sessions", "cwd-a", "s1");
    const b = join(runDirectory, "grok-home", "sessions", "cwd-b", "s2");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, "updates.jsonl"), "{\"a\":1}", "utf8");
    await writeFile(join(b, "updates.jsonl"), "{\"b\":2}\n", "utf8");
    const transition = await projectHostTransitionPriorNative({
      previousHost: "grok-build",
      liveHost: "pi",
      runDirectory,
      piSessionFile: join(runDirectory, "session", "session.jsonl"),
    });
    assert.deepEqual(transition, {
      previousHost: "grok-build",
      priorNativeRecords: "{\"a\":1}\n{\"b\":2}\n",
    });

    // One real updates.jsonl plus a residual empty session dir still keeps the sole file.
    await rm(join(b, "updates.jsonl"));
    const sole = await projectHostTransitionPriorNative({
      previousHost: "grok-build",
      liveHost: "pi",
      runDirectory,
      piSessionFile: join(runDirectory, "session", "session.jsonl"),
    });
    assert.deepEqual(sole, {
      previousHost: "grok-build",
      priorNativeRecords: "{\"a\":1}\n",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
