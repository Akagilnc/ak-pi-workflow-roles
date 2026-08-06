/**
 * #109 package-owned method Skill seam — empty home, no network, exact provenance.
 */
import assert from "node:assert/strict";
import {
  access,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { loadPackagedCanonicalSkillBinding } from "../../src/package-resources/method-skill-binding.ts";
import {
  gitBlobOid,
  loadPackagedMethodSkillMaterial,
  resolvePackagedMethodSkillPath,
  SEALED_UNCHANGED_METHOD_PINS,
} from "../../src/package-resources/method-skill.ts";
import { sha256Hex } from "../../src/sha256.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

const originalHome = process.env.HOME;
const sealedTdd = SEALED_UNCHANGED_METHOD_PINS.tdd;

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

test("packaged tdd method loads from package root in empty home with sealed upstream identity", async () => {
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
    assert.equal(material.provenance.upstream.path, sealedTdd.path);
    assert.equal(material.provenance.upstream.commit, sealedTdd.commit);
    assert.equal(material.provenance.upstream.tag, sealedTdd.tag);
    assert.equal(material.provenance.upstream.license, "MIT");
    assert.equal(
      material.provenance.upstream.copyright,
      "Copyright (c) 2026 Matt Pocock",
    );
    assert.equal(material.provenance.upstream.attribution, "mattpocock/skills");
    assert.equal(material.provenance.packageAdaptation, "unchanged-pinned-snapshot");

    for (const rel of Object.keys(sealedTdd.files)) {
      const expected = sealedTdd.files[rel]!;
      const actual = material.provenance.files[rel];
      assert.ok(actual, `missing file pin ${rel}`);
      assert.equal(actual.sha256, expected.sha256);
      assert.equal(actual.byteLength, expected.byteLength);
      assert.equal(actual.gitBlob, expected.gitBlob);
      const bytes = await readFile(join(material.rootDirectory, rel));
      assert.equal(sha256Hex(bytes), expected.sha256);
      assert.equal(gitBlobOid(bytes), expected.gitBlob);
    }

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

test("mutating package bytes with adjacent manifest rewrite fails sealed unchanged-upstream pin", async () => {
  await withEmptyHome(async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ak-method-mutate-"));
    try {
      const packageRootTemp = join(tempRoot, "pkg");
      const methodDir = join(packageRootTemp, "resources/methods/tdd");
      await cp(join(packageRoot, "resources/methods/tdd"), methodDir, {
        recursive: true,
      });

      const skillPath = join(methodDir, "SKILL.md");
      const mutated = `${await readFile(skillPath, "utf8")}\n# mutated locally\n`;
      await writeFile(skillPath, mutated, "utf8");
      const mutatedBytes = Buffer.from(mutated, "utf8");
      const provenancePath = join(methodDir, "provenance.json");
      const provenance = JSON.parse(await readFile(provenancePath, "utf8")) as {
        packageAdaptation: string;
        upstream: Record<string, string>;
        files: Record<string, { sha256: string; byteLength: number; gitBlob: string }>;
      };
      // Keep the same upstream.commit/tag claim while rewriting adjacent file identities
      // so local self-consistency alone would pass without the sealed pin.
      provenance.files["SKILL.md"] = {
        sha256: sha256Hex(mutatedBytes),
        byteLength: mutatedBytes.byteLength,
        gitBlob: gitBlobOid(mutatedBytes),
      };
      await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");

      await assert.rejects(
        () => loadPackagedMethodSkillMaterial(packageRootTemp, "tdd"),
        /sealed unchanged pin/i,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

test("provenance without immutable upstream commit is rejected", async () => {
  await withEmptyHome(async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ak-method-no-commit-"));
    try {
      const packageRootTemp = join(tempRoot, "pkg");
      const methodDir = join(packageRootTemp, "resources/methods/tdd");
      await cp(join(packageRoot, "resources/methods/tdd"), methodDir, {
        recursive: true,
      });
      const provenancePath = join(methodDir, "provenance.json");
      const provenance = JSON.parse(await readFile(provenancePath, "utf8")) as {
        upstream: Record<string, unknown>;
      };
      delete provenance.upstream.commit;
      await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
      await assert.rejects(
        () => loadPackagedMethodSkillMaterial(packageRootTemp, "tdd"),
        /upstream\.commit/,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
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
