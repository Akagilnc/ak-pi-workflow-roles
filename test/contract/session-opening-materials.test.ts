/**
 * #443 — session opening materials: factory constitution + role-owned extras
 * enter through the three existing loader seams as exact package source bytes.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { loadAuditorSoul } from "../../src/auditor-soul.ts";
import {
  AUDITOR_SESSION_MATERIALS,
  GATEKEEPER_SESSION_MATERIALS,
  MAIN_ROLE_SESSION_MATERIALS,
  joinPackageMaterials,
  loadGatekeeperSessionMaterials,
  loadMainRoleSessionMaterials,
  type AuditorSessionRole,
  type GatekeeperSessionRole,
  type MainRoleSession,
} from "../../src/session-opening-materials.ts";
import {
  GATEKEEPER_OUTPUT_TOOL,
  INSPECTOR_OUTPUT_TOOL,
  runGatekeeper,
} from "../../src/gatekeeper-role.ts";
import { fauxGatekeeper as completion } from "../helpers/faux-gatekeeper.ts";
import {
  getSharedIsolatedPack,
  packageRoot,
  withActivationHome,
  withInProcessPi,
} from "../helpers/pi-test-harness.ts";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

async function sourceBytes(relativePath: string): Promise<string> {
  return readFile(resolve(packageRoot, relativePath), "utf8");
}

async function expectJoined(
  relativePaths: readonly string[],
): Promise<string> {
  const parts = [];
  for (const relativePath of relativePaths) {
    parts.push(await sourceBytes(relativePath));
  }
  return parts.join("\n\n");
}

test("main-role loaders deliver exact package source bytes for every session class", async () => {
  for (const role of Object.keys(
    MAIN_ROLE_SESSION_MATERIALS,
  ) as MainRoleSession[]) {
    const paths = MAIN_ROLE_SESSION_MATERIALS[role];
    const loaded = await loadMainRoleSessionMaterials(role);
    assert.equal(
      loaded,
      await expectJoined(paths),
      `${role} session materials must equal runtime source join`,
    );
  }
});

test("gatekeeper family loaders deliver exact package source bytes", async () => {
  for (const role of Object.keys(
    GATEKEEPER_SESSION_MATERIALS,
  ) as GatekeeperSessionRole[]) {
    const paths = GATEKEEPER_SESSION_MATERIALS[role];
    const loaded = await loadGatekeeperSessionMaterials(role);
    assert.equal(
      loaded,
      await expectJoined(paths),
      `${role} session materials must equal runtime source join`,
    );
  }
});

test("auditor loaders deliver exact package source bytes including factory constitution", async () => {
  for (const role of Object.keys(
    AUDITOR_SESSION_MATERIALS,
  ) as AuditorSessionRole[]) {
    const paths = AUDITOR_SESSION_MATERIALS[role];
    const loaded = await loadAuditorSoul(role);
    assert.equal(
      loaded,
      await expectJoined(paths),
      `${role} auditor materials must equal runtime source join`,
    );
  }
});

test("no session material table injects another role's soul file", () => {
  const tables: ReadonlyArray<{
    readonly label: string;
    readonly ownSoul: string;
    readonly paths: readonly string[];
  }> = [
    ...Object.entries(MAIN_ROLE_SESSION_MATERIALS).map(([owner, paths]) => ({
      label: `main:${owner}`,
      ownSoul: `${owner}.md`,
      paths: paths as readonly string[],
    })),
    ...Object.entries(GATEKEEPER_SESSION_MATERIALS).map(([owner, paths]) => ({
      label: `gatekeeper:${owner}`,
      ownSoul: `${owner}.md`,
      paths: paths as readonly string[],
    })),
    ...Object.entries(AUDITOR_SESSION_MATERIALS).map(([owner, paths]) => ({
      label: `auditor:${owner}`,
      ownSoul: `${owner}-auditor.md`,
      paths: paths as readonly string[],
    })),
  ];

  for (const { label, ownSoul, paths } of tables) {
    const foreignSouls = paths.filter((path) => {
      if (!path.startsWith("souls/") || !path.endsWith(".md")) return false;
      const base = path.slice("souls/".length);
      if (
        base === "quality-law.md" ||
        base.endsWith("-output-guide.md")
      ) {
        return false;
      }
      return base !== ownSoul;
    });
    assert.deepEqual(
      foreignSouls,
      [],
      `${label} must not load another role's soul; found ${foreignSouls.join(",")}`,
    );
  }
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
