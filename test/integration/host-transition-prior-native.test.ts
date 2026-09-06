import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

import { projectHostTransitionPriorNative } from "../../src/host-transition-prior-native.ts";

test("unknown previous or live host yields no hostTransition (no inject)", async () => {
  await withTempRoot("ak-host-transition-unknown-", async (root) => {
    const runDirectory = join(root, "run");
    const piSessionFile = join(runDirectory, "session", "session.jsonl");
    await mkdir(join(runDirectory, "session"), { recursive: true });
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
    });
});

test("pi→grok-build projects the present Pi session path", async () => {
  await withTempRoot("ak-host-transition-pi-path-", async (root) => {
    const runDirectory = join(root, "run");
    const piSessionFile = join(runDirectory, "session", "session.jsonl");
    await mkdir(join(runDirectory, "session"), { recursive: true });
    await writeFile(piSessionFile, "{\"type\":\"session\",\"id\":\"s\"}\n", "utf8");
    assert.deepEqual(
      await projectHostTransitionPriorNative({
        previousHost: "pi",
        liveHost: "grok-build",
        runDirectory,
        piSessionFile,
      }),
      {
        previousHost: "pi",
        priorNativePaths: [piSessionFile],
      },
    );
    });
});

test("grok-build→pi projects every present updates.jsonl path in sorted order", async () => {
  await withTempRoot("ak-host-transition-paths-", async (root) => {
    const runDirectory = join(root, "run");
    const later = join(runDirectory, "grok-home", "sessions", "z-cwd", "s2");
    const earlier = join(runDirectory, "grok-home", "sessions", "a-cwd", "s1");
    await mkdir(later, { recursive: true });
    await mkdir(earlier, { recursive: true });
    const pathLater = join(later, "updates.jsonl");
    const pathEarlier = join(earlier, "updates.jsonl");
    await writeFile(pathLater, "x", "utf8");
    await writeFile(pathEarlier, "y", "utf8");
    const transition = await projectHostTransitionPriorNative({
      previousHost: "grok-build",
      liveHost: "pi",
      runDirectory,
      piSessionFile: join(runDirectory, "session", "session.jsonl"),
    });
    assert.deepEqual(transition, {
      previousHost: "grok-build",
      priorNativePaths: [pathEarlier, pathLater],
    });
    });
});
