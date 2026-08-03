import { readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const entries = [
  "navigator-contracts",
  "navigator-evidence",
  "navigator-role",
  "uuidv7",
  "assisted-contracts",
  "assisted-ledger",
  "assisted-acquisition",
  "assisted-runner",
  "assisted-invocation-transport",
  "assisted-cli",
];
await build({
  entryPoints: entries.map((name) => `src/${name}.ts`),
  outdir: "dist",
  format: "esm",
  platform: "node",
  target: "node20",
  supported: { "import-attributes": true },
  bundle: false,
  packages: "external",
});
for (const name of entries) {
  const path = `dist/${name}.js`;
  const source = await readFile(path, "utf8");
  await writeFile(path, source.replaceAll(/(from\s*["'][^"']+)\.ts(["'])/g, "$1.js$2"));
}
