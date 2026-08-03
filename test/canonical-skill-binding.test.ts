import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { loadCanonicalSkillBinding } from "../src/canonical-skill-binding.ts";
import { reviewerPromptIdentity } from "../src/reviewer-prompt-identity.ts";
import { withPrimaryAwareCleanup } from "./helpers/primary-aware-cleanup.ts";

const originalHome = process.env.HOME;

async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(resolve(tmpdir(), "ak-canonical-skill-"));
  process.env.HOME = home;
  return await withPrimaryAwareCleanup(
    () => run(home),
    async () => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(home, { recursive: true, force: true });
    },
  );
}

async function writeConfiguredSkill(
  home: string,
  name: "tdd" | "code-review",
  raw: string,
): Promise<string> {
  const path = resolve(home, `.agents/skills/${name}/SKILL.md`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, raw);
  return realpath(path);
}

test("canonical binding snapshots the configured Skill and accepts only its native pathname spellings", async () => {
  await withHome(async (home) => {
    const configuredDir = resolve(home, ".agents/skills/tdd");
    const targetDir = resolve(home, "owned-fixture");
    const targetPath = resolve(targetDir, "SKILL.md");
    const raw = [
      "---",
      "name: tdd",
      "description: fixture",
      "---",
      "",
      "# Fixture TDD",
      "",
      "Run one red-green slice.",
      "",
    ].join("\n");
    await mkdir(configuredDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await writeFile(targetPath, raw);
    const configuredPath = resolve(configuredDir, "SKILL.md");
    await symlink(targetPath, configuredPath);

    const binding = await loadCanonicalSkillBinding("tdd");
    const canonicalPath = await realpath(targetPath);
    const body = "# Fixture TDD\n\nRun one red-green slice.";

    assert.equal(binding.name, "tdd");
    assert.deepEqual(binding.snapshot, {
      raw,
      path: canonicalPath,
      baseDir: dirname(canonicalPath),
      body,
      snapshotIdentity: reviewerPromptIdentity(raw),
    });
    assert.equal(binding.invocation("Implement the approved slice."), "/skill:tdd Implement the approved slice.");
    assert.ok(Object.isFrozen(binding));
    assert.ok(Object.isFrozen(binding.snapshot));

    const request = "Implement the approved slice.";
    const configuredContent = `References are relative to ${dirname(configuredPath)}.\n\n${body}`;
    const resolvedContent = `References are relative to ${dirname(canonicalPath)}.\n\n${body}`;
    const configuredExpansion = `<skill name="tdd" location="${configuredPath}">\n${configuredContent}\n</skill>\n\n${request}`;
    const resolvedExpansion = `<skill name="tdd" location="${canonicalPath}">\n${resolvedContent}\n</skill>\n\n${request}`;

    assert.deepEqual(binding.captureExpansion(configuredExpansion, request), {
      name: "tdd",
      location: configuredPath,
      content: configuredContent,
      userMessage: request,
    });
    assert.deepEqual(binding.captureExpansion(resolvedExpansion, request), {
      name: "tdd",
      location: canonicalPath,
      content: resolvedContent,
      userMessage: request,
    });
    assert.deepEqual(
      binding.captureExpansion(
        `<skill name="tdd" location="${configuredPath}">\n${configuredContent}\n</skill>`,
        "",
      ),
      {
        name: "tdd",
        location: configuredPath,
        content: configuredContent,
        userMessage: "",
      },
    );
    assert.equal(
      binding.captureExpansion(
        configuredExpansion.replace(configuredContent, resolvedContent),
        request,
      ),
      undefined,
    );
    assert.equal(
      binding.captureExpansion(
        resolvedExpansion.replace(resolvedContent, configuredContent),
        request,
      ),
      undefined,
    );

    await writeFile(targetPath, raw.replace("Run one red-green slice.", "Changed after activation."));
    const reloaded = await loadCanonicalSkillBinding("tdd");
    assert.notEqual(reloaded.snapshot, binding.snapshot);
    assert.equal(binding.snapshot.raw, raw);
    assert.match(reloaded.snapshot.body, /Changed after activation/);
  });
});

test("canonical binding proves only the complete native expansion", async () => {
  await withHome(async (home) => {
    const raw = [
      "---",
      "name: code-review",
      "description: fixture",
      "---",
      "",
      "# Canonical review",
      "",
      "Inspect behavior and standards.",
    ].join("\n");
    const path = await writeConfiguredSkill(home, "code-review", raw);
    const binding = await loadCanonicalSkillBinding("code-review");
    const request = "Review the requested fixed point.";
    const content = `References are relative to ${dirname(path)}.\n\n# Canonical review\n\nInspect behavior and standards.`;
    const exact = `<skill name="code-review" location="${path}">\n${content}\n</skill>\n\n${request}`;

    const evidence = binding.captureExpansion(exact, request);
    assert.deepEqual(evidence, {
      name: "code-review",
      location: path,
      content,
      userMessage: request,
    });
    assert.ok(Object.isFrozen(evidence));
    assert.notEqual(binding.captureExpansion(exact, request), evidence);

    const rejected = [
      '<skill name="code-review" location="/copy/SKILL.md">',
      `prose\n${exact}`,
      `${exact}\nassistant prose`,
      exact.replace('name="code-review"', 'name="tdd"'),
      exact.replace(path, "/alternate/code-review/SKILL.md"),
      exact.replace(content, "# Canonical review"),
      exact.replace(`References are relative to ${dirname(path)}.\n\n`, ""),
      exact.replace(`References are relative to ${dirname(path)}.`, "References are relative elsewhere."),
      exact.replace(request, "Review a different point."),
    ];
    for (const prompt of rejected) {
      assert.equal(binding.captureExpansion(prompt, request), undefined, prompt);
    }
  });
});

test("canonical binding fails closed for unavailable and empty Skills", async () => {
  await withHome(async (home) => {
    const missing = resolve(home, ".agents/skills/tdd/SKILL.md");
    await assert.rejects(
      loadCanonicalSkillBinding("tdd"),
      (error: unknown) => {
        assert.match(String(error), /Canonical tdd Skill is unavailable/);
        assert.ok(String(error).includes(missing));
        return true;
      },
    );

    await mkdir(missing, { recursive: true });
    await assert.rejects(
      loadCanonicalSkillBinding("tdd"),
      /Canonical tdd Skill is unavailable.*SKILL\.md/i,
    );

    await rm(missing, { recursive: true, force: true });
    await writeConfiguredSkill(
      home,
      "tdd",
      "---\nname: tdd\ndescription: no body\n---\n\n",
    );
    await assert.rejects(
      loadCanonicalSkillBinding("tdd"),
      /Canonical tdd Skill is empty.*SKILL\.md/i,
    );
  });
});
