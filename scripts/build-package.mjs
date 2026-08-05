import { readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const entries = ["packaged-role-registry", "navigator-attendance", "activation-ledger-topology", "activation-reconciliation"];
await build({
  entryPoints: entries.map((name) => `src/${name}.ts`),
  outdir: "dist",
  format: "esm",
  platform: "node",
  target: "node20",
  bundle: false,
  packages: "external",
});
for (const name of entries) {
  const path = `dist/${name}.js`;
  const source = await readFile(path, "utf8");
  await writeFile(path, source.replaceAll(/(from\s*["'][^"']+)\.ts(["'])/g, "$1.js$2"));
}
