/**
 * #822 — non-pi envelope prompt free of Pi `/skill:`; Pi adapter forces single method.
 * Coder / reviewer / merger share applyPiNativeSkillInvocation via RoleTurnRequest.methods.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareAcpRoleEnvelope } from "../../src/acp-host/role-envelope.ts";
import { headlessTurnArgs } from "../../src/headless-host/description.ts";
import { lookupHeadlessHostDescription } from "../../src/host-descriptions.ts";
import { resolvePackagedMethodSkillPath } from "../../src/package-resources/method-skill.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import {
  applyPiNativeSkillInvocation,
  buildPiTurnExtraArgs,
} from "../../src/pi/role-turn-host.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { packageRoot, seedGitRepository } from "../helpers/pi-test-harness.ts";

test("applyPiNativeSkillInvocation: single forced method for coder/reviewer/merger; fixer pair plain", () => {
  const tdd = { kind: "skill" as const, path: "/x/resources/methods/tdd/SKILL.md" };
  const review = { kind: "skill" as const, path: "/x/resources/methods/code-review/SKILL.md" };
  const merge = {
    kind: "skill" as const,
    path: "/x/resources/methods/resolving-merge-conflicts/SKILL.md",
  };
  const bugs = {
    kind: "skill" as const,
    path: "/x/resources/methods/diagnosing-bugs/SKILL.md",
  };
  assert.equal(applyPiNativeSkillInvocation([tdd], "task"), "/skill:tdd task");
  assert.equal(applyPiNativeSkillInvocation([review], "task"), "/skill:code-review task");
  assert.equal(
    applyPiNativeSkillInvocation([merge], "merge it"),
    "/skill:resolving-merge-conflicts merge it",
  );
  assert.equal(applyPiNativeSkillInvocation([bugs, tdd], "fix"), "fix");
  assert.equal(applyPiNativeSkillInvocation([], "plain"), "plain");
});

test("buildPiTurnExtraArgs: merger single method forces Pi-native slash on argv", () => {
  const skillPath = resolvePackagedMethodSkillPath(packageRoot, "resolving-merge-conflicts");
  const sessionDirectory = "/tmp/ak-822-merger-session";
  const args = buildPiTurnExtraArgs(
    {
      principal: fixturePrincipal(sessionDirectory),
      activation: { role: "merger", inputPath: "/input.json" },
      methods: [{ kind: "skill", path: skillPath }],
      continuation: { kind: "initial", prompt: "Complete the merge." },
      cwd: "/tmp",
      home: "/tmp",
      agentDir: "/tmp/agent",
      runDirectory: "/tmp/run",
    },
    piDurablePrincipalAuthority,
  );
  assert.equal(
    args.some((a) => a.startsWith("/skill:resolving-merge-conflicts ")),
    true,
  );
});

test("prepareAcpRoleEnvelope: coder apply user prompt stays free of /skill:; method enters systemPrompt", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-822-envelope-"));
  const project = join(runDirectory, "project");
  const taskPath = join(runDirectory, "task.md");
  const skillPath = resolvePackagedMethodSkillPath(packageRoot, "tdd");
  const socketPath = join(runDirectory, "mcp.sock");
  try {
    await mkdir(project, { recursive: true });
    seedGitRepository(project);
    await writeFile(taskPath, "Build the slice.\n", "utf8");
    const assignment = "#822\n\n已受理附件（冻结快照路径）：\n- /tmp/a.md";
    const prepared = await prepareAcpRoleEnvelope({
      request: {
        principal: fixturePrincipal(join(runDirectory, "session")),
        activation: { role: "coder", phase: "apply", taskPath },
        methods: [{ kind: "skill", path: skillPath }],
        continuation: { kind: "initial", prompt: assignment },
        cwd: project,
        home: runDirectory,
        agentDir: join(runDirectory, "agent"),
        runDirectory,
      },
      dependencies: {
        loadJudgeSoul: async () => "JUDGE",
        loadCoderSoul: async () => "CODER SOUL",
        loadCoderTask: async (path) => {
          assert.equal(path, taskPath);
          return "task body";
        },
        loadCanonicalSkillBinding: async (name) => {
          assert.equal(name, "tdd");
          const { loadPackagedCanonicalSkillBinding } = await import(
            "../../src/package-resources/method-skill-binding.ts"
          );
          return loadPackagedCanonicalSkillBinding(packageRoot, "tdd");
        },
      },
      socketPath,
    });
    try {
      assert.equal(prepared.prompt.startsWith("/skill:"), false, prepared.prompt.slice(0, 80));
      assert.equal(prepared.prompt, assignment);
      assert.match(prepared.systemPrompt.body, /TDD|red|green|test/i);
      assert.match(prepared.systemPrompt.body, /coder_soul|CODER SOUL/);

      const claude = lookupHeadlessHostDescription("claude");
      assert.ok(claude, "claude headless description must exist");
      const systemPromptPath = join(runDirectory, "headless-system-prompt.txt");
      await writeFile(systemPromptPath, prepared.systemPrompt.body, "utf8");
      const argv = headlessTurnArgs({
        description: claude!,
        prompt: prepared.prompt,
        systemPromptPath,
        jsonSchema: prepared.jsonSchema,
        session: { kind: "new", id: "sess-822" },
      });
      const promptFlagAt = argv.indexOf(claude!.promptFlag);
      assert.equal(promptFlagAt >= 0, true);
      const hostPrompt = argv[promptFlagAt + 1]!;
      assert.equal(hostPrompt.startsWith("/skill:"), false);
      assert.equal(hostPrompt, assignment);
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});
