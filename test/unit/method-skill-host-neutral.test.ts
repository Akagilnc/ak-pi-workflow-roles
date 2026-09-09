/**
 * #822 — real-entry seam: non-pi envelope prompt stays free of Pi `/skill:`.
 * Pi-native form is covered by public-cli coder/merger argv tracers.
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
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { packageRoot, seedGitRepository } from "../helpers/pi-test-harness.ts";

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
      // Mutation target: restoring role-body `/skill:` transform turns this red.
      assert.equal(prepared.prompt.startsWith("/skill:"), false, prepared.prompt.slice(0, 80));
      assert.equal(prepared.prompt, assignment);
      assert.match(prepared.systemPrompt.body, /TDD|red|green|test/i);
      assert.match(prepared.systemPrompt.body, /coder_soul|CODER SOUL/);

      // Headless family (claude): same prepared.prompt rides the host prompt flag — no Pi slash.
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
