/**
 * #443 — session opening materials: factory constitution + role-owned extras
 * enter through the three existing loader seams as exact package source bytes.
 *
 * Expected path lists below are ticket-derived oracles (independent of
 * production tables). Deleting a required material from production must fail.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

import { loadAuditorSoul, AUDITOR_SOUL_ROLES } from "../../src/auditor-soul.ts";
import {
  GATEKEEPER_OUTPUT_TOOL,
  INSPECTOR_OUTPUT_TOOL,
  runGatekeeper,
} from "../../src/gatekeeper-role.ts";
import { createJudgeRoleRuntime } from "../../src/judge-role.ts";
import {
  joinPackageMaterials,
  loadGatekeeperSessionMaterials,
  loadMainRoleSessionMaterials,
} from "../../src/session-opening-materials.ts";
import { createCoderRoleRuntime, createFixerRoleRuntime } from "../../src/worker-role.ts";
import { fauxGatekeeper as completion } from "../helpers/faux-gatekeeper.ts";
import {
  getSharedIsolatedPack,
  packageRoot,
  withActivationHome,
  withInProcessPi,
} from "../helpers/pi-test-harness.ts";

/** Ticket #443 What-to-build oracles — not imported from production tables. */
const TICKET_MAIN_MATERIALS = {
  judge: ["CLAUDE.md", "souls/judge.md", "souls/judge-output-guide.md"],
  fixer: [
    "CLAUDE.md",
    "souls/fixer.md",
    "souls/quality-law.md",
    "souls/fixer-output-guide.md",
  ],
  coder: [
    "CLAUDE.md",
    "souls/coder.md",
    "souls/quality-law.md",
    "souls/coder-output-guide.md",
  ],
  reviewer: ["CLAUDE.md", "souls/reviewer.md"],
  collector: ["CLAUDE.md", "souls/collector.md"],
  doctor: ["CLAUDE.md", "souls/doctor.md"],
  merger: ["CLAUDE.md", "souls/merger.md"],
  navigator: ["CLAUDE.md", "souls/navigator.md"],
} as const;

const TICKET_GATEKEEPER_MATERIALS = {
  gatekeeper: ["CLAUDE.md", "souls/gatekeeper.md"],
  inspector: ["CLAUDE.md", "souls/inspector.md", "souls/quality-law.md"],
  notary: ["CLAUDE.md", "souls/notary.md"],
} as const;

const TICKET_AUDITOR_MATERIALS = {
  judge: ["CLAUDE.md", "souls/judge-auditor.md"],
  reviewer: ["CLAUDE.md", "souls/reviewer-auditor.md"],
  doctor: ["CLAUDE.md", "souls/doctor-auditor.md"],
} as const;

async function sourceBytes(relativePath: string): Promise<string> {
  return readFile(resolve(packageRoot, relativePath), "utf8");
}

async function expectJoined(relativePaths: readonly string[]): Promise<string> {
  const parts = [];
  for (const relativePath of relativePaths) {
    parts.push(await sourceBytes(relativePath));
  }
  return parts.join("\n\n");
}

function roleHarness(
  extraFlags: Readonly<Record<string, string>> = {},
) {
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
  const tools = new Map<string, { name: string }>();
  const pi = {
    registerFlag() {},
    getFlag(name: string) {
      return extraFlags[name];
    },
    on(name: string, handler: (event: unknown, ctx?: unknown) => unknown) {
      handlers.set(name, handler);
    },
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
    getAllTools() {
      return [...tools.keys()].map((name) => ({ name }));
    },
    setActiveTools() {},
    appendEntry() {},
  };
  return { pi, handlers, tools };
}

test("main-role loaders match ticket material roster byte-for-byte", async () => {
  for (const [role, paths] of Object.entries(TICKET_MAIN_MATERIALS)) {
    const loaded = await loadMainRoleSessionMaterials(
      role as keyof typeof TICKET_MAIN_MATERIALS,
    );
    assert.equal(
      loaded,
      await expectJoined(paths),
      `${role} must carry ticket materials from package source`,
    );
  }
});

test("gatekeeper family loaders match ticket material roster byte-for-byte", async () => {
  for (const [role, paths] of Object.entries(TICKET_GATEKEEPER_MATERIALS)) {
    const loaded = await loadGatekeeperSessionMaterials(
      role as keyof typeof TICKET_GATEKEEPER_MATERIALS,
    );
    assert.equal(
      loaded,
      await expectJoined(paths),
      `${role} must carry ticket materials from package source`,
    );
  }
});

test("auditor loaders match ticket material roster byte-for-byte", async () => {
  for (const role of AUDITOR_SOUL_ROLES) {
    const paths = TICKET_AUDITOR_MATERIALS[role];
    const loaded = await loadAuditorSoul(role);
    assert.equal(
      loaded,
      await expectJoined(paths),
      `${role} auditor must carry ticket materials from package source`,
    );
  }
});

test("loaded sessions never include another role's soul bytes", async () => {
  const judgeSoul = await sourceBytes("souls/judge.md");
  const fixerSoul = await sourceBytes("souls/fixer.md");
  const coderSoul = await sourceBytes("souls/coder.md");
  const inspectorSoul = await sourceBytes("souls/inspector.md");
  const judgeAuditorSoul = await sourceBytes("souls/judge-auditor.md");

  const judge = await loadMainRoleSessionMaterials("judge");
  const fixer = await loadMainRoleSessionMaterials("fixer");
  const inspector = await loadGatekeeperSessionMaterials("inspector");
  const judgeAuditor = await loadAuditorSoul("judge");

  assert.equal(judge.includes(fixerSoul), false);
  assert.equal(judge.includes(coderSoul), false);
  assert.equal(judge.includes(inspectorSoul), false);
  assert.equal(judge.includes(judgeAuditorSoul), false);

  assert.equal(fixer.includes(judgeSoul), false);
  assert.equal(fixer.includes(coderSoul), false);

  assert.equal(inspector.includes(judgeSoul), false);
  assert.equal(inspector.includes(fixerSoul), false);

  assert.equal(judgeAuditor.includes(judgeSoul), false);
  assert.equal(judgeAuditor.includes(fixerSoul), false);
});

test("missing injected material fails as native ENOENT, not a soft empty", async () => {
  await assert.rejects(
    () => joinPackageMaterials(["souls/__no_such_opening_material__.md"]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("Judge real entry prompt carries constitution and output-guide bytes", async () => {
  const constitution = await sourceBytes("CLAUDE.md");
  const soul = await sourceBytes("souls/judge.md");
  const guide = await sourceBytes("souls/judge-output-guide.md");
  const materials = await loadMainRoleSessionMaterials("judge");

  const harness = roleHarness();
  const runtime = createJudgeRoleRuntime(
    harness.pi as unknown as ExtensionAPI,
    {
      loadSoul: () => loadMainRoleSessionMaterials("judge"),
      auditSoulCompliance: async () => ({ status: "pass" }),
    },
    {
      failInfrastructure(error) {
        throw error;
      },
    },
  );
  await runtime.activate();
  const prompt = (
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE" },
      {} as ExtensionContext,
    )
  ) as { systemPrompt: string };

  assert.equal(
    prompt.systemPrompt,
    `BASE\n\n<judge_soul>\n${materials.trim()}\n</judge_soul>`,
  );
  assert.equal(prompt.systemPrompt.includes(constitution), true);
  assert.equal(prompt.systemPrompt.includes(soul), true);
  assert.equal(prompt.systemPrompt.includes(guide), true);
  // Foreign role soul must not appear in the visible prompt.
  assert.equal(
    prompt.systemPrompt.includes(await sourceBytes("souls/fixer.md")),
    false,
  );
});

test("Coder real entry prompt carries constitution, quality-law, and output-guide bytes", async () => {
  const constitution = await sourceBytes("CLAUDE.md");
  const qualityLaw = await sourceBytes("souls/quality-law.md");
  const guide = await sourceBytes("souls/coder-output-guide.md");
  const materials = await loadMainRoleSessionMaterials("coder");

  const harness = roleHarness({
    "ak-coder-task": "/task.md",
    "ak-coder-phase": "plan",
  });
  const runtime = createCoderRoleRuntime(
    harness.pi as unknown as ExtensionAPI,
    {
      loadSoul: () => loadMainRoleSessionMaterials("coder"),
      loadTask: async () => "task body",
    },
    {
      failInfrastructure(error) {
        throw error;
      },
    },
  );
  await runtime.activate();
  const prompt = (
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE" },
      {
        cwd: packageRoot,
        sessionManager: { getSessionDir: () => packageRoot },
      },
    )
  ) as { systemPrompt: string };

  assert.equal(prompt.systemPrompt.includes(constitution), true);
  assert.equal(prompt.systemPrompt.includes(qualityLaw), true);
  assert.equal(prompt.systemPrompt.includes(guide), true);
  assert.equal(prompt.systemPrompt.includes(materials.trim()), true);
  assert.equal(
    prompt.systemPrompt.includes(await sourceBytes("souls/judge.md")),
    false,
  );
});

test("Fixer real entry prompt carries constitution, quality-law, and output-guide bytes", async () => {
  const constitution = await sourceBytes("CLAUDE.md");
  const qualityLaw = await sourceBytes("souls/quality-law.md");
  const guide = await sourceBytes("souls/fixer-output-guide.md");
  const materials = await loadMainRoleSessionMaterials("fixer");

  const harness = roleHarness({
    "ak-fix-packet": "/packet.md",
    "ak-fixer-phase": "apply",
  });
  const runtime = createFixerRoleRuntime(
    harness.pi as unknown as ExtensionAPI,
    {
      loadSoul: () => loadMainRoleSessionMaterials("fixer"),
      loadPacket: async () =>
        JSON.stringify({
          instructions: "fix",
          prerequisites: [],
        }),
    },
    {
      failInfrastructure(error) {
        throw error;
      },
    },
  );
  await runtime.activate();
  const prompt = (
    await harness.handlers.get("before_agent_start")?.(
      { systemPrompt: "BASE" },
      {} as ExtensionContext,
    )
  ) as { systemPrompt: string };

  assert.equal(prompt.systemPrompt.includes(constitution), true);
  assert.equal(prompt.systemPrompt.includes(qualityLaw), true);
  assert.equal(prompt.systemPrompt.includes(guide), true);
  assert.equal(prompt.systemPrompt.includes(materials.trim()), true);
  assert.equal(
    prompt.systemPrompt.includes(await sourceBytes("souls/coder.md")),
    false,
  );
});

async function withParent(run: (context: any) => Promise<void>) {
  await withActivationHome(
    { prefix: "ak-opening-materials-" },
    async ({ agentDir, home }) => {
      const faux = fauxProvider({
        api: "opening-materials-parent",
        provider: "opening-materials-parent",
        tokenSize: { min: 1000, max: 1000 },
      });
      faux.setResponses([fauxAssistantMessage("parent")]);
      await withInProcessPi(
        {
          cwd: home,
          agentDir,
          faux,
          modelsPath: null,
          noExtensions: true,
          noTools: "builtin",
          mode: "print",
          systemPrompt: "BASE",
          flags: {},
        },
        async ({ session, model }) => {
          await run({
            cwd: home,
            model,
            modelRegistry: {
              getProvider() {
                return undefined;
              },
              async getProviderAuth() {
                return { auth: {} };
              },
              async getApiKeyAndHeaders() {
                return { ok: true };
              },
            },
            thinkingLevel: "off",
            sessionManager: session.sessionManager,
          });
        },
      );
    },
  );
}

test("Gatekeeper real entry injects factory constitution and inspector quality-law bytes", async () => {
  const constitution = await sourceBytes("CLAUDE.md");
  const qualityLaw = await sourceBytes("souls/quality-law.md");
  const gatekeeperSoul = await sourceBytes("souls/gatekeeper.md");
  const inspectorSoul = await sourceBytes("souls/inspector.md");

  await withParent(async (context) => {
    const seen: string[] = [];
    const result = await runGatekeeper({
      context,
      subject: {
        kind: "worker_completion",
        material: "implementation and test evidence",
      },
      runCompletion: completion(
        [
          {
            tool: GATEKEEPER_OUTPUT_TOOL,
            args: { status: "dispatch", officer: "inspector" },
          },
          {
            tool: INSPECTOR_OUTPUT_TOOL,
            args: { status: "pass", findings: [] },
          },
        ],
        seen,
      ),
    });
    assert.deepEqual(result, {
      status: "pass",
      officer: "inspector",
      findings: [],
    });
    assert.equal(seen.length, 2);
    assert.equal(
      seen[0],
      [constitution, gatekeeperSoul].join("\n\n") +
        "\n\n" +
        "取证工具不受白名单限制；若取证产生临时副作用，取证结束后须自行恢复。",
    );
    assert.equal(
      seen[1],
      [constitution, inspectorSoul, qualityLaw].join("\n\n") +
        "\n\n" +
        "取证工具不受白名单限制；若取证产生临时副作用，取证结束后须自行恢复。",
    );
    // Cross-role: officer prompt must not carry notary soul.
    assert.equal(
      seen[1]!.includes(await sourceBytes("souls/notary.md")),
      false,
    );
  });
});

test("npm pack ships CLAUDE.md on the files surface", async () => {
  const pack = await getSharedIsolatedPack();
  assert.ok(
    pack.files.some((file) => file.path === "CLAUDE.md"),
    "npm pack file list must include CLAUDE.md",
  );
});

test("Gatekeeper loadSoul native failure projects as typed transport_failure", async () => {
  await withParent(async (context) => {
    const missing = Object.assign(
      new Error(
        "ENOENT: no such file or directory, open 'souls/__missing__.md'",
      ),
      { code: "ENOENT" },
    );
    const result = await runGatekeeper({
      context,
      subject: { kind: "judge_draft", material: "draft" },
      loadSoul: async () => {
        throw missing;
      },
    });
    assert.equal(result.status, "transport_failure");
    if (result.status === "transport_failure") {
      assert.equal(result.stage, "gatekeeper");
      assert.match(result.reason, /ENOENT/);
    }
  });
});
