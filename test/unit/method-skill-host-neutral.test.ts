/**
 * #822 — method Skill load is middle-layer; Pi `/skill:` stays adapter-internal.
 * Non-pi envelope prompt must not start with Pi slash syntax.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildAcpSkillExpansion,
  prepareAcpRoleEnvelope,
} from "../../src/acp-host/role-envelope.ts";
import {
  applyPiNativeSkillInvocation,
  buildPiTurnExtraArgs,
} from "../../src/pi/role-turn-host.ts";
import { resolvePackagedMethodSkillPath } from "../../src/package-resources/method-skill.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { packageRoot, seedGitRepository } from "../helpers/pi-test-harness.ts";

test("buildAcpSkillExpansion: plain prompt + single method yields typed evidence", () => {
  const path = "/pkg/resources/methods/tdd/SKILL.md";
  const body = "# TDD\nred then green";
  const methods = new Map([["tdd", { path, body }]]);
  const prompt = "#822\n\nDo the work.";
  const evidence = buildAcpSkillExpansion(methods, prompt);
  assert.deepEqual(evidence, {
    name: "tdd",
    location: path,
    content: `References are relative to /pkg/resources/methods/tdd.\n\n${body}`,
    userMessage: prompt,
  });
});

test("buildAcpSkillExpansion: residual /skill: form still parses", () => {
  const path = "/pkg/resources/methods/tdd/SKILL.md";
  const body = "body";
  const methods = new Map([["tdd", { path, body }]]);
  const evidence = buildAcpSkillExpansion(methods, "/skill:tdd original task");
  assert.equal(evidence?.name, "tdd");
  assert.equal(evidence?.userMessage, "original task");
});

test("applyPiNativeSkillInvocation: single method prefixes; many/zero leave plain", () => {
  const tdd = { kind: "skill" as const, path: "/x/resources/methods/tdd/SKILL.md" };
  const review = { kind: "skill" as const, path: "/x/resources/methods/code-review/SKILL.md" };
  assert.equal(
    applyPiNativeSkillInvocation([tdd], "Implement it."),
    "/skill:tdd Implement it.",
  );
  assert.equal(
    applyPiNativeSkillInvocation([tdd], "/skill:tdd already"),
    "/skill:tdd already",
  );
  assert.equal(applyPiNativeSkillInvocation([], "plain"), "plain");
  assert.equal(applyPiNativeSkillInvocation([tdd, review], "plain"), "plain");
});

test("buildPiTurnExtraArgs: coder apply prompt carries Pi-native /skill:tdd only in adapter argv", () => {
  const skillPath = resolvePackagedMethodSkillPath(packageRoot, "tdd");
  const sessionDirectory = "/tmp/ak-pi-skill-neutral-session";
  const sessionFile = join(sessionDirectory, "session.jsonl");
  const args = buildPiTurnExtraArgs(
    {
      principal: fixturePrincipal(sessionDirectory, sessionFile),
      activation: { role: "coder", phase: "apply", taskPath: "/task.md" },
      methods: [{ kind: "skill", path: skillPath }],
      continuation: { kind: "initial", prompt: "Apply the approved plan." },
      cwd: "/tmp",
      home: "/tmp",
      agentDir: "/tmp/agent",
      runDirectory: "/tmp/run",
    },
    piDurablePrincipalAuthority,
  );
  const prompt = args.at(-1);
  assert.equal(typeof prompt, "string");
  assert.equal((prompt as string).startsWith("/skill:tdd "), true);
  assert.equal((prompt as string).includes("Apply the approved plan."), true);
});

test("prepareAcpRoleEnvelope: coder apply user prompt stays free of /skill:; method enters systemPrompt", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "ak-822-envelope-"));
  const project = join(runDirectory, "project");
  const taskPath = join(runDirectory, "task.md");
  const skillPath = resolvePackagedMethodSkillPath(packageRoot, "tdd");
  const socketPath = join(runDirectory, "mcp.sock");
  try {
    const { mkdir } = await import("node:fs/promises");
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
    } finally {
      await prepared.dispose?.();
    }
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});
