import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { testTmpdir } from "../helpers/worktree-temp.ts";

import {
  loadCanonicalSkillBinding,
} from "../../src/canonical-skill-binding.ts";
import type { HostSkillExpansionEvidence } from "../../src/host-contracts.ts";
import { withPrimaryAwareCleanup } from "../helpers/primary-aware-cleanup.ts";

const originalHome = process.env.HOME;

async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(resolve(testTmpdir(), "ak-canonical-skill-"));
  process.env.HOME = home;
  return await withPrimaryAwareCleanup(
    () => run(home),
    async () => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
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

function evidence(
  name: string,
  location: string,
  content: string,
  userMessage: string,
): HostSkillExpansionEvidence {
  return { name, location, content, userMessage };
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
      snapshotIdentity: Object.freeze({ text: raw }),
    });
    assert.equal(binding.invocation("Implement the approved slice."), "/skill:tdd Implement the approved slice.");
    assert.ok(Object.isFrozen(binding));
    assert.ok(Object.isFrozen(binding.snapshot));

    const request = "Implement the approved slice.";
    const configuredContent = `References are relative to ${dirname(configuredPath)}.\n\n${body}`;
    const resolvedContent = `References are relative to ${dirname(canonicalPath)}.\n\n${body}`;
    const configuredEvidence = evidence("tdd", configuredPath, configuredContent, request);
    const resolvedEvidence = evidence("tdd", canonicalPath, resolvedContent, request);

    assert.deepEqual(binding.captureExpansion(configuredEvidence, request), {
      name: "tdd",
      location: configuredPath,
      content: configuredContent,
      userMessage: request,
    });
    assert.deepEqual(binding.captureExpansion(resolvedEvidence, request), {
      name: "tdd",
      location: canonicalPath,
      content: resolvedContent,
      userMessage: request,
    });
    assert.deepEqual(
      binding.captureExpansion(evidence("tdd", configuredPath, configuredContent, ""), ""),
      {
        name: "tdd",
        location: configuredPath,
        content: configuredContent,
        userMessage: "",
      },
    );
    assert.equal(
      binding.captureExpansion(
        evidence("tdd", configuredPath, resolvedContent, request),
        request,
      ),
      undefined,
    );
    assert.equal(
      binding.captureExpansion(
        evidence("tdd", canonicalPath, configuredContent, request),
        request,
      ),
      undefined,
    );

    await writeFile(targetPath, raw.replace("Run one red-green slice.", "Changed after activation."));
    const reloaded = await loadCanonicalSkillBinding("tdd");
    assert.notEqual(reloaded.snapshot, binding.snapshot);
    assert.equal(binding.snapshot.raw, raw);
    assert.match(reloaded.snapshot.body, /Changed after activation/);

    // Only complete typed evidence proves capture: frozen, freshly allocated, closed matrix.
    const captured = binding.captureExpansion(configuredEvidence, request);
    assert.ok(captured);
    assert.ok(Object.isFrozen(captured));
    assert.notEqual(binding.captureExpansion(configuredEvidence, request), captured);

    const rejected: HostSkillExpansionEvidence[] = [
      evidence("tdd", "/copy/SKILL.md", resolvedContent, request),
      evidence("code-review", canonicalPath, resolvedContent, request),
      evidence("tdd", "/alternate/tdd/SKILL.md", resolvedContent, request),
      evidence("tdd", canonicalPath, body, request),
      evidence(
        "tdd",
        canonicalPath,
        resolvedContent.replace(`References are relative to ${dirname(canonicalPath)}.\n\n`, ""),
        request,
      ),
      evidence(
        "tdd",
        canonicalPath,
        resolvedContent.replace(
          `References are relative to ${dirname(canonicalPath)}.`,
          "References are relative elsewhere.",
        ),
        request,
      ),
      evidence("tdd", canonicalPath, resolvedContent, "Review a different point."),
    ];
    for (const row of rejected) {
      assert.equal(binding.captureExpansion(row, request), undefined, JSON.stringify(row));
    }
    assert.equal(binding.captureExpansion(undefined, request), undefined);
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
