/**
 * #922 host-native method loader — shortest argv/staging tracers.
 * Live host expansion is true-run evidence, not mocked here.
 */
import assert from "node:assert/strict";
import { mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acpStdioArgs } from "../../src/acp-host/description.ts";
import { codexTurnArgs, headlessTurnArgs } from "../../src/headless-host/description.ts";
import {
  applyCodexSkillInvocation,
  applyHostSlashSkillInvocation,
  forcedPluginSlashToken,
  hostMethodSkills,
  packagedMethodPluginDir,
  stageCodexSkillHome,
} from "../../src/host-native-method.ts";
import {
  HEADLESS_HOST_DESCRIPTIONS,
  HOST_DESCRIPTIONS,
} from "../../src/host-descriptions.ts";

const tddPath = join(process.cwd(), "resources/methods/tdd/SKILL.md");
const tddDir = join(process.cwd(), "resources/methods/tdd");
const packageRoot = process.cwd();

test("#922 operator-surface closers gone; native loader argv present", () => {
  const claude = HEADLESS_HOST_DESCRIPTIONS.claude;
  assert.ok(claude && claude.protocol === "claude-print");
  assert.equal(claude.fixedArgs.includes("--setting-sources"), false);
  const grok = HOST_DESCRIPTIONS["grok-build"]!;
  assert.equal(Object.keys(grok.childEnv).some((k) => k.includes("SKILLS_ENABLED")), false);

  const pluginDir = packagedMethodPluginDir(packageRoot);
  const claudeArgv = headlessTurnArgs({
    description: claude,
    systemPromptPath: "/tmp/sys.txt",
    jsonSchema: { type: "object" },
    mcpConfigPath: "/tmp/mcp.json",
    session: { kind: "new", id: "sid" },
    pluginDir,
  });
  assert.equal(claudeArgv[claudeArgv.indexOf("--plugin-dir") + 1], pluginDir);

  assert.equal(codexTurnArgs({
    systemPromptPath: "/tmp/sys.txt",
    outputSchemaPath: "/tmp/out.json",
    mcpServers: [],
    session: { kind: "new" },
  }).includes("--ignore-user-config"), false);

  const grokArgv = acpStdioArgs(grok, { model: "m" }, undefined, { pluginDir });
  assert.ok(grokArgv.indexOf("--plugin-dir") < grokArgv.indexOf("stdio"));

  const hermesArgv = acpStdioArgs(HOST_DESCRIPTIONS.hermes!, undefined, undefined, {
    skillsArgs: ["--skills", "tdd"],
  });
  assert.ok(hermesArgv.indexOf("--skills") < hermesArgv.indexOf("acp"));
});

test("#922 packaged plugin + codex overlay + invocation", async () => {
  const skills = hostMethodSkills([{ kind: "skill", path: tddPath }]);
  assert.deepEqual(skills, [{ name: "tdd", dir: tddDir, path: tddPath }]);
  assert.equal(forcedPluginSlashToken([{ kind: "skill", path: tddPath }]), "ak-methods:tdd");
  assert.equal(applyHostSlashSkillInvocation("ak-methods:tdd", "t"), "/ak-methods:tdd t");
  const linked = `[$tdd](${tddPath})`;
  assert.equal(applyCodexSkillInvocation(skills, "t"), `${linked} t`);

  const pluginSkills = join(packagedMethodPluginDir(packageRoot), "skills", "tdd");
  assert.equal(await readlink(pluginSkills), join("..", "..", "methods", "tdd"));

  const root = await mkdtemp(join(tmpdir(), "ak-922-"));
  const emptyHome = await mkdtemp(join(tmpdir(), "ak-922-home-"));
  try {
    const codex = await stageCodexSkillHome({
      runDirectory: root,
      operatorHome: emptyHome,
      methods: [{ kind: "skill", path: tddPath }],
    });
    assert.equal(await readlink(join(codex!.home, ".agents", "skills", "tdd")), tddDir);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(emptyHome, { recursive: true, force: true });
  }
});
