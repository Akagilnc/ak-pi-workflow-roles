import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
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
        piSessionFile,
      }),
      undefined,
    );
    assert.equal(
      await projectHostTransitionPriorNative({
        previousHost: "pi",
        liveHost: "third-adapter",
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
        piSessionFile,
      }),
      {
        previousHost: "pi",
        priorNativePaths: [piSessionFile],
      },
    );
  });
});

test("grok-build→pi projects present sitian records under sessionParent topology, never session.jsonl", async () => {
  await withTempRoot("ak-host-transition-paths-", async (root) => {
    const runDirectory = join(root, "run");
    const piSessionFile = join(runDirectory, "session", "session.jsonl");
    const sessionRoot = dirname(piSessionFile);
    // Sitian topology (resolveSitianRecordPathInLedger + sessionParent):
    // dirname(sessionParent)/<category>/records.jsonl — never session.jsonl.
    const later = join(sessionRoot, "z-category", "records.jsonl");
    const earlier = join(sessionRoot, "a-category", "records.jsonl");
    await mkdir(dirname(later), { recursive: true });
    await mkdir(dirname(earlier), { recursive: true });
    await writeFile(piSessionFile, "{\"type\":\"session\",\"id\":\"s\"}\n", "utf8");
    await writeFile(later, "{\"kind\":\"z\"}\n", "utf8");
    await writeFile(earlier, "{\"kind\":\"a\"}\n", "utf8");
    const transition = await projectHostTransitionPriorNative({
      previousHost: "grok-build",
      liveHost: "pi",
      piSessionFile,
    });
    assert.deepEqual(transition, {
      previousHost: "grok-build",
      priorNativePaths: [earlier, later],
    });
    assert.equal(transition?.priorNativePaths.includes(piSessionFile), false);
  });
});

test("grok-build→pi with only Pi session.jsonl yields empty sitian path list", async () => {
  await withTempRoot("ak-host-transition-empty-sitian-", async (root) => {
    const runDirectory = join(root, "run");
    const piSessionFile = join(runDirectory, "session", "session.jsonl");
    await mkdir(join(runDirectory, "session"), { recursive: true });
    await writeFile(piSessionFile, "{\"type\":\"session\",\"id\":\"s\"}\n", "utf8");
    assert.deepEqual(
      await projectHostTransitionPriorNative({
        previousHost: "grok-build",
        liveHost: "pi",
        piSessionFile,
      }),
      {
        previousHost: "grok-build",
        priorNativePaths: [],
      },
    );
  });
});
