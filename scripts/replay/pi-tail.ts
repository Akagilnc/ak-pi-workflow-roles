// Rebuild the system-prompt tail a pi-host seat received: <role_soul> plus the
// role-reference-materials and case-dossier-pointer reading materials. The
// registry and renderer are loaded from the frozen worktree (argv[2]) so every
// byte comes from the judged HEAD:
//   AK_REPLAY_POINTER=<kit>/pointer.md node --import tsx pi-tail.ts <role> <kit>/wt
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [role, wt] = process.argv.slice(2);
if (!role || !wt) throw new Error("usage: pi-tail.ts <role> <worktree>");
const registry = await import(pathToFileURL(join(wt, "src/packaged-role-registry.ts")).href);
const render = await import(pathToFileURL(join(wt, "src/agent-start-materials.ts")).href);
const record = (registry.PUBLIC_ROLE_RECORDS as readonly { role: string; sessionMaterials?: readonly string[] }[])
  .find((entry) => entry.role === role);
if (record === undefined) throw new Error(`unknown role: ${role}`);
const soulPath = join(wt, "souls", `${role}.md`);
if (!existsSync(soulPath)) {
  throw new Error(`no souls/${role}.md at this HEAD (subject-selected soul, e.g. auditor); hand-build --sys`);
}
const soul = readFileSync(soulPath, "utf8");
const reference = (record.sessionMaterials ?? [])
  .filter((p) => p !== `souls/${role}.md`)
  .map((p) => readFileSync(join(wt, p), "utf8"))
  .join("\n\n");
const materials: unknown[] = [];
if (reference !== "") materials.push({ kind: "role-reference-materials", content: reference });
const pointerPath = process.env.AK_REPLAY_POINTER;
if (pointerPath && existsSync(pointerPath)) {
  const section = readFileSync(pointerPath, "utf8");
  if (section.trim() !== "") materials.push({ kind: "case-dossier-pointer", frozenPath: pointerPath, section });
}
process.stdout.write(render.renderAgentStartMaterials(`<${role}_soul>\n${soul}\n</${role}_soul>`, materials));
