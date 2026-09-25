// Rebuild the system-prompt tail a pi-host seat received: <role_soul> + the
// role-reference-materials line. Run inside the frozen worktree so the bytes
// come from the judged HEAD:  node --import tsx scripts/replay/pi-tail.ts <role>
import { readFileSync } from "node:fs";
import { packagedRoleMetadata } from "../../src/packaged-role-registry.ts";
import { renderAgentStartMaterials } from "../../src/agent-start-materials.ts";

const role = process.argv[2];
const meta = packagedRoleMetadata(role ?? "");
if (meta === undefined) throw new Error(`unknown role: ${role}`);
const soul = readFileSync(`souls/${role}.md`, "utf8");
const materials = (meta as { sessionMaterials?: readonly string[] }).sessionMaterials ?? [];
const reference = materials.filter((p) => p !== `souls/${role}.md`).map((p) => readFileSync(p, "utf8")).join("\n\n");
const tail = `<${role}_soul>\n${soul}\n</${role}_soul>`;
process.stdout.write(renderAgentStartMaterials(tail, reference === "" ? [] : [{ kind: "role-reference-materials", content: reference }]));
