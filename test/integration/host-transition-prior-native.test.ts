import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createGrokRoleTurnHost,
  type GrokAcpConnection,
  type GrokSessionIdentityAuthority,
} from "../../src/grok/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { projectHostTransitionPriorNative } from "../../src/host-transition-prior-native.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";

test("unknown previous or live host yields no hostTransition (no inject)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-host-transition-unknown-"));
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pi→grok-build projects the present Pi session path", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-host-transition-pi-path-"));
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grok-build→pi projects every present updates.jsonl path in sorted order", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-host-transition-paths-"));
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi→Grok resume ACP prompt delivers the session path and not the session bytes", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-grok-prior-path-"));
  try {
    const runDirectory = join(home, "run");
    const sessionDirectory = join(runDirectory, "session");
    const piSessionFile = join(sessionDirectory, "session.jsonl");
    const uniqueBytes = "ak-prior-native-secret-marker-9f3c";
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(piSessionFile, uniqueBytes, "utf8");
    const prompts: unknown[] = [];
    const sessionIds = new WeakMap<object, string>();
    const sessionIdentity: GrokSessionIdentityAuthority = {
      async load(principal) { return sessionIds.get(principal as object); },
      async bind(principal, sessionId) { sessionIds.set(principal as object, sessionId); },
      resolveSessionFile() { return piSessionFile; },
    };
    const connection: GrokAcpConnection = {
      async request(method, params) {
        if (method === "initialize") {
          return {
            agentCapabilities: { loadSession: true },
            _meta: { modelState: { availableModels: [{ modelId: "grok-4.5" }] } },
          };
        }
        if (method === "session/new") return { sessionId: "s1" };
        if (method === "session/prompt") {
          prompts.push(params);
          return { stopReason: "end_turn" };
        }
        if (method === "session/close") return {};
        throw new Error(method);
      },
      notify() {},
      async close() {},
    };
    const host = createGrokRoleTurnHost({
      sessionIdentity,
      recordCapabilities: async () => {},
      connect: async () => connection,
      inspect: async () => ({ privateActive: [], akActive: ["ak_judge_output"] }),
      prepare: async () => ({
        mcpServers: [{}],
        systemPrompt: { body: "law", materials: [] },
        prompt: "decide",
        closeRound: async () => ({ accepted: true }),
      }),
    });
    const request = {
      principal: fixturePrincipal(sessionDirectory, piSessionFile),
      activation: { role: "judge" },
      methods: [],
      continuation: { kind: "resume", prompt: "decide" },
      model: { provider: "xai", model: "grok-4.5" },
      cwd: "/work",
      home,
      agentDir: join(home, "agent"),
      runDirectory,
      hostTransition: { previousHost: "pi", priorNativePaths: [piSessionFile] },
    } as RoleTurnRequest;
    const result = await host.executeTurn(request);
    assert.equal(result.code, 0);
    const serialized = JSON.stringify(prompts);
    assert.equal(serialized.includes(piSessionFile), true);
    assert.equal(serialized.includes(uniqueBytes), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
