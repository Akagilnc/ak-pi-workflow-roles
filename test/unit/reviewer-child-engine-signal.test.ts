/**
 * #818 — request-scoped engine signal reaches axis child through the real wire:
 * RoleHost flag → role-runtime runDispatch injection → agent options → executeReviewerChild
 * → resolveEngineName (same gate as parent registration).
 *
 * External face: getFlag is read for ENGINE_FLAG_NAME and resolves to the request engine
 * (or blocks ambient when empty); armed name matches createEngineDetourToolDefinition tool.
 * No process.env write. Pi path (absent getFlag) still falls through to child env.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AK_ROLE_ENGINE_ENV,
  ENGINE_DETOUR_TOOL_NAME,
  ENGINE_FLAG_NAME,
  resolveEngineName,
} from "../../src/engine-detour.ts";
import { createEngineDetourToolDefinition } from "../../src/engine-detour-tool.ts";
import type {
  HostContext,
  HostEventRegistration,
  HostToolDefinition,
  RoleEnvelopeHost,
  RoleHost,
} from "../../src/host-contracts.ts";
import { loadPackagedCanonicalSkillBinding } from "../../src/package-resources/method-skill-binding.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { createReviewerAgentRunner } from "../../src/reviewer-agent.ts";
import type { AcceptedReviewerExecution } from "../../src/reviewer-dispatch.ts";
import type { ReviewerPinnedGitReader, ReviewerPinnedTarget } from "../../src/reviewer-pinned-git.ts";
import { createRoleRuntimeExtension } from "../../src/role-runtime.ts";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function repositoryFixture(): Promise<{
  root: string;
  target: ReviewerPinnedTarget;
}> {
  const root = await mkdtemp(worktreeTempPrefix("ak-818-child-engine-"));
  git(root, "-c", "init.defaultBranch=main", "init");
  git(root, "config", "user.name", "Reviewer Engine Test");
  git(root, "config", "user.email", "reviewer-engine@example.invalid");
  await writeFile(join(root, "tracked.txt"), "pinned\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "pinned target");
  const targetHead = git(root, "rev-parse", "HEAD^{commit}");
  const objectFormat = git(root, "rev-parse", "--show-object-format") as "sha1" | "sha256";
  return {
    root,
    target: Object.freeze({
      repositoryRoot: root,
      objectFormat,
      targetHead,
      refs: Object.freeze({}),
    }),
  };
}

function stubReader(target: ReviewerPinnedTarget): ReviewerPinnedGitReader {
  const base = target.targetHead;
  return {
    pin: target,
    async snapshot() {
      return target;
    },
    async resolve() {
      return base;
    },
    async range() {
      return Object.freeze({
        base,
        target: target.targetHead,
        diffCommand: `git diff ${base} ${target.targetHead}`,
        diffSha256: "a".repeat(64),
        commits: Object.freeze([]) as readonly string[],
      });
    },
    async featureTokens() {
      return Object.freeze([]);
    },
    async listSpecCandidatePaths() {
      return Object.freeze([]);
    },
    async originRepository() {
      return undefined;
    },
    async commitMessagesNewestFirst() {
      return Object.freeze([]);
    },
    async readPinnedText() {
      return undefined;
    },
  };
}

function hostContext(cwd: string): HostContext {
  return {
    cwd,
    mode: "prompt",
    model: { provider: "test-provider" },
    sessionManager: {
      getLeafEntry: () => undefined,
      getLeafId: () => null,
      getEntries: () => [],
      getSessionDir: () => join(cwd, "session"),
      getSessionFile: () => join(cwd, "session", "session.jsonl"),
      appendCustomEntry() {},
    },
    abort() {},
  };
}

/**
 * Probe getFlag: records ENGINE_FLAG_NAME reads and the resolved engine name
 * the child gate would arm (same resolveEngineName + detour factory as production).
 */
function engineFlagProbe(value: string): {
  getFlag: (name: string) => boolean | string | undefined;
  reads: string[];
  resolved: () => string | undefined;
  armedToolName: () => string | undefined;
} {
  const reads: string[] = [];
  let last: string | undefined;
  const getFlag = (name: string): boolean | string | undefined => {
    reads.push(name);
    if (name === ENGINE_FLAG_NAME) {
      last = value;
      return value;
    }
    return undefined;
  };
  return {
    getFlag,
    reads,
    resolved: () => resolveEngineName(getFlag),
    armedToolName: () => {
      const engineName = resolveEngineName(getFlag);
      if (engineName === undefined) return undefined;
      return createEngineDetourToolDefinition({
        engineName,
        fail(error) {
          throw error;
        },
      }).name;
    },
  };
}

test("real wire: role-runtime injects RoleHost engine flag into runReviewerDispatch", async () => {
  const previous = process.env[AK_ROLE_ENGINE_ENV];
  delete process.env[AK_ROLE_ENGINE_ENV];
  const home = await mkdtemp(join(tmpdir(), "ak-818-runtime-engine-"));
  const runDir = join(home, ".ak-roles", "books", "probe", "runs", "run-818@reviewer");
  await mkdir(join(runDir, "session"), { recursive: true });
  const previousRunDir = process.env.AK_ROLE_RUN_DIR;
  process.env.AK_ROLE_RUN_DIR = runDir;

  let capturedGetFlag: ((name: string) => boolean | string | undefined) | undefined;

  try {
    const flags = new Map<string, boolean | string | undefined>([
      ["ak-role", "reviewer"],
      ["ak-engine", "agy"],
      ["ak-review-base", "HEAD"],
    ]);
    const handlers = new Map<string, (event: unknown, ctx: HostContext) => unknown>();
    const tools = new Map<string, HostToolDefinition>();
    const host: RoleHost = {
      registerFlag(name, definition) {
        if (!flags.has(name) && definition.default !== undefined) {
          flags.set(name, definition.default);
        }
      },
      getFlag(name) {
        return flags.get(name);
      },
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
      getAllTools: () => [...tools.keys()].map((name) => ({ name })),
      setActiveTools() {},
      getActiveTools: () => [],
      on(...registration: HostEventRegistration) {
        const [event, handler] = registration;
        handlers.set(event, handler as (event: unknown, ctx: HostContext) => unknown);
      },
    };
    const envelopeHost: RoleEnvelopeHost = {
      host,
      appendEntry() {},
      async sendMessage() {},
      startKeepalive() {},
      stopKeepalive() {},
    };

    const fixture = await repositoryFixture();
    try {
      createRoleRuntimeExtension({
        loadJudgeSoul: async () => "judge soul",
        loadReviewerSoul: async () => "reviewer soul",
        createReviewerPinnedGitReader: async () => stubReader(fixture.target),
        loadCanonicalSkillBinding: async (name) => {
          if (name !== "code-review") throw new Error(`unexpected skill ${name}`);
          return loadPackagedCanonicalSkillBinding(packageRoot, "code-review");
        },
        // Capture the injected getFlag at the real runDispatch → agent boundary.
        runReviewerDispatch: async (dispatch, options) => {
          capturedGetFlag = options.getFlag;
          const standards = dispatch.legs.find((leg) => leg.axis === "standards");
          assert.ok(standards !== undefined, "dispatch must include standards leg");
          return {
            identity: dispatch.identity,
            target: dispatch.targetSnapshot,
            legs: {
              standards: {
                status: "successful" as const,
                report: "ok",
                usage: emptyUsage,
                target: dispatch.targetSnapshot,
                prompt: standards.prompt,
                workspaceDisposition: "deleted" as const,
              },
            },
          };
        },
      })(envelopeHost);

      // Durable principal session file under AK_ROLE_RUN_DIR (activation ledger).
      const sessionDir = join(runDir, "session");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, "session.jsonl"),
        `${JSON.stringify({ type: "session", version: 3, id: "run-818", timestamp: new Date().toISOString(), cwd: fixture.root })}\n`,
        "utf8",
      );
      const ctx: HostContext = {
        cwd: fixture.root,
        mode: "prompt",
        model: { provider: "test-provider" },
        sessionManager: {
          getLeafEntry: () => undefined,
          getLeafId: () => null,
          getEntries: () => [],
          getSessionDir: () => sessionDir,
          getSessionFile: () => join(sessionDir, "session.jsonl"),
          appendCustomEntry() {},
        },
        abort() {},
      };
      await handlers.get("session_start")?.({ reason: "test" }, ctx);

      assert.equal(typeof capturedGetFlag, "function", "role-runtime must inject getFlag");
      assert.equal(process.env[AK_ROLE_ENGINE_ENV], undefined, "must not write process.env");
      // Same gate the child uses: request flag arms agy.
      assert.equal(resolveEngineName(capturedGetFlag), "agy");
      // Empty ambient must not override the injected flag reader.
      process.env[AK_ROLE_ENGINE_ENV] = "ambient-noise";
      assert.equal(resolveEngineName(capturedGetFlag), "agy");
      const tool = createEngineDetourToolDefinition({
        engineName: "agy",
        fail(error) {
          throw error;
        },
      });
      assert.equal(tool.name, ENGINE_DETOUR_TOOL_NAME);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
    if (previousRunDir === undefined) delete process.env.AK_ROLE_RUN_DIR;
    else process.env.AK_ROLE_RUN_DIR = previousRunDir;
    if (previous === undefined) delete process.env[AK_ROLE_ENGINE_ENV];
    else process.env[AK_ROLE_ENGINE_ENV] = previous;
  }
});

test("real wire: agent forwards getFlag into executeReviewerChild (engine arming read)", async () => {
  const previous = process.env[AK_ROLE_ENGINE_ENV];
  delete process.env[AK_ROLE_ENGINE_ENV];
  const fixture = await repositoryFixture();
  try {
    const probe = engineFlagProbe("agy");
    const agent = createReviewerAgentRunner({ packageRoot });
    const execution: AcceptedReviewerExecution = Object.freeze({
      identity: "wire-agent",
      recipe: "reviewer-common-bundle-v1",
      targetSnapshot: fixture.target,
      legs: Object.freeze([
        Object.freeze({ axis: "standards" as const, prompt: "standards axis prompt" }),
      ]),
    });

    // Non-pi HostContext → parentSelection fails AFTER engine gate reads getFlag.
    await assert.rejects(
      () =>
        agent.run(execution, {
          context: hostContext(fixture.root),
          getFlag: probe.getFlag,
        }),
      /pi host context|parent model|Reviewer/,
    );

    assert.ok(
      probe.reads.includes(ENGINE_FLAG_NAME),
      `agent must forward getFlag so child reads ${ENGINE_FLAG_NAME}; reads=${JSON.stringify(probe.reads)}`,
    );
    assert.equal(probe.resolved(), "agy");
    assert.equal(probe.armedToolName(), ENGINE_DETOUR_TOOL_NAME);
    assert.equal(process.env[AK_ROLE_ENGINE_ENV], undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    if (previous === undefined) delete process.env[AK_ROLE_ENGINE_ENV];
    else process.env[AK_ROLE_ENGINE_ENV] = previous;
  }
});

test("real wire: empty injected flag blocks ambient env at child gate", async () => {
  const previous = process.env[AK_ROLE_ENGINE_ENV];
  process.env[AK_ROLE_ENGINE_ENV] = "ambient-should-not-arm";
  const fixture = await repositoryFixture();
  try {
    const probe = engineFlagProbe(""); // envelope projects "" when request has no engine
    const agent = createReviewerAgentRunner({ packageRoot });
    const execution: AcceptedReviewerExecution = Object.freeze({
      identity: "wire-empty",
      recipe: "reviewer-common-bundle-v1",
      targetSnapshot: fixture.target,
      legs: Object.freeze([
        Object.freeze({ axis: "standards" as const, prompt: "standards axis prompt" }),
      ]),
    });

    await assert.rejects(
      () =>
        agent.run(execution, {
          context: hostContext(fixture.root),
          getFlag: probe.getFlag,
        }),
      /pi host context|parent model|Reviewer/,
    );

    assert.ok(probe.reads.includes(ENGINE_FLAG_NAME));
    assert.equal(probe.resolved(), undefined, "empty flag must block ambient");
    assert.equal(probe.armedToolName(), undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    if (previous === undefined) delete process.env[AK_ROLE_ENGINE_ENV];
    else process.env[AK_ROLE_ENGINE_ENV] = previous;
  }
});

test("real wire: absent getFlag falls back to child env (pi path)", async () => {
  const previous = process.env[AK_ROLE_ENGINE_ENV];
  process.env[AK_ROLE_ENGINE_ENV] = "from-pi-child-env";
  const fixture = await repositoryFixture();
  try {
    const reads: string[] = [];
    // No getFlag on options — production pi path.
    const agent = createReviewerAgentRunner({ packageRoot });
    const execution: AcceptedReviewerExecution = Object.freeze({
      identity: "wire-pi-env",
      recipe: "reviewer-common-bundle-v1",
      targetSnapshot: fixture.target,
      legs: Object.freeze([
        Object.freeze({ axis: "standards" as const, prompt: "standards axis prompt" }),
      ]),
    });

    await assert.rejects(
      () =>
        agent.run(execution, {
          context: hostContext(fixture.root),
          // getFlag omitted
        }),
      /pi host context|parent model|Reviewer/,
    );

    // Without getFlag, child falls through to env — arming name is the env value.
    assert.equal(resolveEngineName(), "from-pi-child-env");
    assert.equal(reads.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    if (previous === undefined) delete process.env[AK_ROLE_ENGINE_ENV];
    else process.env[AK_ROLE_ENGINE_ENV] = previous;
  }
});
