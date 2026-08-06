/**
 * #109 package-owned method Skill seam — empty home, no network, exact provenance.
 */
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { loadPackagedCanonicalSkillBinding } from "../../src/package-resources/method-skill-binding.ts";
import {
  loadPackagedMethodSkillMaterial,
  resolvePackagedMethodSkillPath,
} from "../../src/package-resources/method-skill.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

const originalHome = process.env.HOME;

async function withEmptyHome<T>(run: () => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-empty-home-method-"));
  process.env.HOME = home;
  try {
    // Empty home: no ~/.agents/skills at all.
    await assert.rejects(
      () => access(join(home, ".agents", "skills")),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    return await run();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  }
}

test("packaged tdd method loads from package root in empty home with companions and provenance", async () => {
  await withEmptyHome(async () => {
    const material = await loadPackagedMethodSkillMaterial(packageRoot, "tdd");
    assert.equal(material.name, "tdd");
    assert.equal(material.body.includes("Test-Driven Development"), true);
    assert.equal(material.companionRelativePaths.includes("tests.md"), true);
    assert.equal(material.companionRelativePaths.includes("mocking.md"), true);
    assert.equal(
      material.companionRelativePaths.includes("agents/openai.yaml"),
      true,
    );
    assert.equal(
      material.provenance.upstream.repository,
      "https://github.com/mattpocock/skills",
    );
    assert.equal(material.provenance.upstream.license, "MIT");
    assert.equal(
      material.provenance.upstream.copyright,
      "Copyright (c) 2026 Matt Pocock",
    );
    assert.equal(material.provenance.upstream.attribution, "mattpocock/skills");
    assert.equal(material.provenance.packageAdaptation, "unchanged-pinned-snapshot");
    assert.equal(typeof material.provenance.files["SKILL.md"]?.sha256, "string");
    assert.equal(material.provenance.files["SKILL.md"]!.sha256.length, 64);

    // Companion bodies are the pinned package bytes (readable without network).
    const tests = await readFile(join(material.rootDirectory, "tests.md"), "utf8");
    const mocking = await readFile(join(material.rootDirectory, "mocking.md"), "utf8");
    assert.equal(tests.includes("Good and Bad Tests"), true);
    assert.equal(mocking.includes("When to Mock"), true);

    // Skill path is under the package tree, not HOME.
    assert.equal(material.skillPath.includes(packageRoot), true);
    assert.equal(material.skillPath.includes(".agents/skills"), false);
  });
});

test("packaged tdd binding captures expansion against package skill path only", async () => {
  await withEmptyHome(async () => {
    const binding = await loadPackagedCanonicalSkillBinding(packageRoot, "tdd");
    assert.equal(binding.name, "tdd");
    const request = "Implement the approved slice.";
    assert.equal(binding.invocation(request), `/skill:tdd ${request}`);

    // Use binding snapshot paths for exact expansion (realpath may differ by OS).
    const location = binding.snapshot.path;
    const expectedContent = `References are relative to ${binding.snapshot.baseDir}.\n\n${binding.snapshot.body}`;
    const prompt = `<skill name="tdd" location="${location}">\n${expectedContent}\n</skill>\n\n${request}`;
    assert.deepEqual(binding.captureExpansion(prompt, request), {
      name: "tdd",
      location,
      content: expectedContent,
      userMessage: request,
    });

    // Configured (non-realpath) package path spelling is also accepted.
    const configuredPath = resolvePackagedMethodSkillPath(packageRoot, "tdd");
    const configuredExpected = `References are relative to ${dirname(configuredPath)}.\n\n${binding.snapshot.body}`;
    const configuredPrompt = `<skill name="tdd" location="${configuredPath}">\n${configuredExpected}\n</skill>\n\n${request}`;
    assert.deepEqual(binding.captureExpansion(configuredPrompt, request), {
      name: "tdd",
      location: configuredPath,
      content: configuredExpected,
      userMessage: request,
    });

    // Ambient home path must not satisfy package binding.
    const homeFake = `<skill name="tdd" location="/tmp/fake-home/.agents/skills/tdd/SKILL.md">\n${expectedContent}\n</skill>\n\n${request}`;
    assert.equal(binding.captureExpansion(homeFake, request), undefined);
  });
});
