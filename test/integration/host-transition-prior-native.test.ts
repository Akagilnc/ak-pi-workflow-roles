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

test("known pi→grok-build projects priorNativeRecords as exact source bytes including trailing newline", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-host-transition-pi-"));
  try {
    const runDirectory = join(root, "run");
    const piSessionFile = join(runDirectory, "session", "host-issued.jsonl");
    await mkdir(join(runDirectory, "session"), { recursive: true });
    const bytes = "{\"type\":\"session\",\"id\":\"s\"}\n{\"type\":\"message\",\"id\":\"m\"}\n";
    await writeFile(piSessionFile, bytes, "utf8");

    const transition = await projectHostTransitionPriorNative({
      previousHost: "pi",
      liveHost: "grok-build",
      runDirectory,
      piSessionFile,
    });
    assert.deepEqual(transition, {
      previousHost: "pi",
      priorNativeRecords: bytes,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grok-build→pi with multiple updates.jsonl yields empty priorNativeRecords (no unordered join)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-host-transition-multi-grok-"));
  try {
    const runDirectory = join(root, "run");
    const a = join(runDirectory, "grok-home", "sessions", "cwd-a", "s1");
    const b = join(runDirectory, "grok-home", "sessions", "cwd-b", "s2");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, "updates.jsonl"), "{\"a\":1}\n", "utf8");
    await writeFile(join(b, "updates.jsonl"), "{\"b\":2}\n", "utf8");
    const transition = await projectHostTransitionPriorNative({
      previousHost: "grok-build",
      liveHost: "pi",
      runDirectory,
      piSessionFile: join(runDirectory, "session", "session.jsonl"),
    });
    assert.deepEqual(transition, {
      previousHost: "grok-build",
      priorNativeRecords: "",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
