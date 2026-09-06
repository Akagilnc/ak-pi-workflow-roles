/**
 * #736 — a resumed labor turn's handbook basis is the current packaged notes file.
 * The resume prompt carries pointers only: handbook path plus the owner-domain
 * resume-basis note when packaged. Never material body (#600 / engine-material
 * contract "Never delivers material body"), never machine instruction (ADR 0073).
 */
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import {
  buildResumeContinuationPrompt,
  RESUME_TRANSPORT_ENVELOPE,
  selectResumeContinuationPrompt,
} from "../../src/public-cli/run-lifecycle.ts";

const HANDBOOK_BODY = "UNIQUE_HANDBOOK_BODY_736";
const RESUME_BASIS_BODY = "UNIQUE_RESUME_BASIS_BODY_736";

async function writePackagedNotes(root: string): Promise<{
  handbookPath: string;
  resumeBasisPath: string;
}> {
  const handbookPath = join(root, "resources", "engines", "only.md");
  const resumeBasisPath = join(root, "resources", "engine-resume-basis.md");
  await mkdir(join(root, "resources", "engines"), { recursive: true });
  await writeFile(handbookPath, `# only\n\n${HANDBOOK_BODY}\n`, "utf8");
  await writeFile(resumeBasisPath, `# basis\n\n${RESUME_BASIS_BODY}\n`, "utf8");
  return { handbookPath, resumeBasisPath };
}

test("resume prompt points at handbook and packaged resume-basis note, body never delivered", async () => {
  await withTempRoot("resume-basis-", async (root) => {
    const { handbookPath, resumeBasisPath } = await writePackagedNotes(root);

    const prompt = buildResumeContinuationPrompt({ packageRoot: root, engine: "only" });
    const lines = prompt.split("\n");

    assert.equal(lines[0], RESUME_TRANSPORT_ENVELOPE);
    assert.ok(
      lines.includes(`- ${handbookPath}`),
      "resume prompt must carry the current handbook path pointer",
    );
    assert.ok(
      lines.includes(`- ${resumeBasisPath}`),
      "resume prompt must carry the packaged resume-basis note pointer",
    );
    assert.equal(prompt.includes(HANDBOOK_BODY), false, "handbook body must not be pasted");
    assert.equal(prompt.includes(RESUME_BASIS_BODY), false, "basis body must not be pasted");
  });
});

test("resume prompt omits the resume-basis pointer when that note is not packaged", async () => {
  await withTempRoot("resume-basis-absent-", async (root) => {
    const { handbookPath, resumeBasisPath } = await writePackagedNotes(root);
    await rm(resumeBasisPath);

    const prompt = buildResumeContinuationPrompt({ packageRoot: root, engine: "only" });
    const lines = prompt.split("\n");

    assert.ok(lines.includes(`- ${handbookPath}`));
    assert.equal(
      lines.includes(`- ${resumeBasisPath}`),
      false,
      "absent note must not be pointed at",
    );
  });
});

test("no engine resume prompt stays the bare transport envelope", async () => {
  await withTempRoot("resume-basis-no-engine-", async (root) => {
    await writePackagedNotes(root);

    assert.equal(
      buildResumeContinuationPrompt({ packageRoot: root }),
      RESUME_TRANSPORT_ENVELOPE,
    );
    assert.equal(selectResumeContinuationPrompt(), RESUME_TRANSPORT_ENVELOPE);
  });
});

test("name-only engine resume prompt carries the name coordinate and no path pointers", async () => {
  await withTempRoot("resume-basis-name-only-", async (root) => {
    const { resumeBasisPath } = await writePackagedNotes(root);

    const prompt = buildResumeContinuationPrompt({ packageRoot: root, engine: "absent-notes" });
    const lines = prompt.split("\n");

    assert.equal(lines[0], RESUME_TRANSPORT_ENVELOPE);
    assert.ok(lines.includes("- engine: absent-notes"));
    assert.equal(
      lines.some((line) => line.startsWith("- ") && line.includes("/resources/")),
      false,
      "name-only resume must not point at any packaged notes",
    );
    assert.equal(prompt.includes(resumeBasisPath), false);
  });
});
