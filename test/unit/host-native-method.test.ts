/**
 * #922 host-native method loader — argv / prompt projection tracers.
 * Does not mock real hosts; live expansion is true-run evidence.
 */
import assert from "node:assert/strict";
import { mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acpStdioArgs } from "../../src/acp-host/description.ts";
import {
  codexTurnArgs,
  headlessTurnArgs,
} from "../../src/headless-host/description.ts";
import {
  applyCodexSkillInvocation,
  applyHostSlashSkillInvocation,
  HOST_METHOD_PLUGIN_NAME,
  hostMethodSkills,
  pluginSkillToken,
  stageCodexSkillHome,
  stageHostMethodPlugin,
} from "../../src/host-native-method.ts";
import {
  HEADLESS_HOST_DESCRIPTIONS,
  HOST_DESCRIPTIONS,
  lookupHeadlessHostDescription,
} from "../../src/host-descriptions.ts";

const tddPath = join(process.cwd(), "resources/methods/tdd/SKILL.md");
const tddDir = join(process.cwd(), "resources/methods/tdd");

test("#922 hostMethodSkills projects skill bindings only", () => {
  assert.deepEqual(
    hostMethodSkills([{ kind: "skill", path: tddPath }]),
    [{ name: "tdd", dir: tddDir, path: tddPath }],
  );
});

test("#922 Claude fixedArgs no longer close setting-sources", () => {
  const claude = HEADLESS_HOST_DESCRIPTIONS.claude;
  assert.ok(claude && claude.protocol === "claude-print");
  assert.equal(claude.fixedArgs.includes("--setting-sources"), false);
});

test("#922 grok childEnv no longer disables vendor skill compat", () => {
  const grok = HOST_DESCRIPTIONS["grok-build"];
  assert.ok(grok);
  const keys = Object.keys(grok.childEnv);
  assert.equal(keys.some((key) => key.includes("SKILLS_ENABLED")), false);
});

test("#922 Claude argv carries --plugin-dir for staged methods", () => {
  const description = lookupHeadlessHostDescription("claude");
  assert.ok(description && description.protocol === "claude-print");
  const argv = headlessTurnArgs({
    description,
    systemPromptPath: "/tmp/sys.txt",
    jsonSchema: { type: "object" },
    mcpConfigPath: "/tmp/mcp.json",
    session: { kind: "new", id: "sid" },
    pluginDir: "/tmp/host-method-plugin",
  });
  const index = argv.indexOf("--plugin-dir");
  assert.notEqual(index, -1);
  assert.equal(argv[index + 1], "/tmp/host-method-plugin");
});

test("#922 Codex argv no longer ignores user config/rules", () => {
  const argv = codexTurnArgs({
    systemPromptPath: "/tmp/sys.txt",
    outputSchemaPath: "/tmp/out.json",
    mcpServers: [],
    session: { kind: "new" },
  });
  assert.equal(argv.includes("--ignore-user-config"), false);
  assert.equal(argv.includes("--ignore-rules"), false);
});

test("#922 grok ACP argv places --plugin-dir before stdio", () => {
  const grok = HOST_DESCRIPTIONS["grok-build"];
  assert.ok(grok);
  const argv = acpStdioArgs(grok, { model: "grok-4" }, undefined, {
    pluginDir: "/tmp/host-method-plugin",
  });
  const pluginIndex = argv.indexOf("--plugin-dir");
  const stdioIndex = argv.indexOf("stdio");
  assert.notEqual(pluginIndex, -1);
  assert.notEqual(stdioIndex, -1);
  assert.ok(pluginIndex < stdioIndex);
  assert.equal(argv[pluginIndex + 1], "/tmp/host-method-plugin");
});

test("#922 hermes ACP argv places --skills before acp", () => {
  const hermes = HOST_DESCRIPTIONS.hermes;
  assert.ok(hermes);
  const argv = acpStdioArgs(hermes, { thinking: "high" }, { profileName: "ak-coder" }, {
    skillsArgs: ["--skills", "tdd"],
  });
  const skillsIndex = argv.indexOf("--skills");
  const acpIndex = argv.indexOf("acp");
  assert.notEqual(skillsIndex, -1);
  assert.notEqual(acpIndex, -1);
  assert.ok(skillsIndex < acpIndex);
  assert.equal(argv[skillsIndex + 1], "tdd");
});

test("#922 slash and codex invocations are idempotent for one forced skill", () => {
  const token = pluginSkillToken(HOST_METHOD_PLUGIN_NAME, "tdd");
  assert.equal(applyHostSlashSkillInvocation(token, "task"), `/${token} task`);
  assert.equal(applyHostSlashSkillInvocation(token, `/${token} task`), `/${token} task`);
  const skills = hostMethodSkills([{ kind: "skill", path: tddPath }]);
  const linked = "[$tdd](" + tddPath + ")";
  assert.equal(applyCodexSkillInvocation(skills, "task"), linked + " task");
  assert.equal(applyCodexSkillInvocation(skills, linked + " task"), linked + " task");
  assert.equal(applyCodexSkillInvocation(skills, "$tdd task"), "$tdd task");
});

test("#922 stageHostMethodPlugin symlinks packaged method dirs", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-922-plugin-"));
  try {
    const staged = await stageHostMethodPlugin(root, [{ kind: "skill", path: tddPath }]);
    assert.ok(staged);
    assert.equal(staged.slashToken, "ak-methods:tdd");
    assert.equal(await readlink(join(staged.pluginDir, "skills", "tdd")), tddDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#922 stageCodexSkillHome overlays package methods under HOME/.agents/skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "ak-922-codex-"));
  const emptyHome = await mkdtemp(join(tmpdir(), "ak-922-empty-home-"));
  try {
    const staged = await stageCodexSkillHome({
      runDirectory: root,
      operatorHome: emptyHome,
      methods: [{ kind: "skill", path: tddPath }],
    });
    assert.ok(staged);
    assert.equal(await readlink(join(staged.home, ".agents", "skills", "tdd")), tddDir);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(emptyHome, { recursive: true, force: true });
  }
});
