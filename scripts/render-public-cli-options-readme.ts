/**
 * #342 — regenerate README EN/ZH public-cli-options sections from the sole
 * typed option table. Run after editing src/public-cli/option-definitions.ts:
 *
 *   node --import tsx scripts/render-public-cli-options-readme.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applyReadmeOptionsSection } from "../src/public-cli/option-definitions.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function rewrite(path: string, locale: "en" | "zh"): Promise<void> {
  const before = await readFile(path, "utf8");
  const after = applyReadmeOptionsSection(before, locale);
  if (after !== before) {
    await writeFile(path, after, "utf8");
    process.stdout.write(`updated ${path}\n`);
  } else {
    process.stdout.write(`clean ${path}\n`);
  }
}

await rewrite(resolve(root, "README.md"), "en");
await rewrite(resolve(root, "README.zh-CN.md"), "zh");
