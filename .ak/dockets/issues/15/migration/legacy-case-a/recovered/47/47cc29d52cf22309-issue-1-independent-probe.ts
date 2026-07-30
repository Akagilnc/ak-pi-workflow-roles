import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createFixerRoleRuntime } from "/Users/akagilnc/WorkSpace/ak-pi-workflow-roles/src/worker-role.ts";
import { withHermeticHome, withInProcessPi, packageRoot, loadRawPackageManifest, resolvePackageEntrypoint } from "/Users/akagilnc/WorkSpace/ak-pi-workflow-roles/test/helpers/pi-test-harness.ts";

(async () => {
const literals = ["rm -rf", "git reset --hard", "git clean", "git checkout --"] as const;
const textOf = (m: ToolResultMessage) => m.content.filter(p => p.type === "text").map(p => p.text).join("\n");
const resultFor = (entries: any[], id: string): ToolResultMessage => {
  const e = entries.find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === id);
  assert.ok(e?.type === "message" && e.message.role === "toolResult", `missing result ${id}`);
  return e.message;
};
const absent = async (path: string) => assert.rejects(() => access(path), /ENOENT/);

// Direct lifecycle probe: only bash + string command is inspected, and list order controls first match.
{
  const handlers = new Map<string, Function[]>();
  const fakePi: any = {
    registerFlag() {}, registerTool() {},
    getFlag(name: string) { return name === "ak-fixer-phase" ? "plan" : "/tmp/p"; },
    on(name: string, fn: Function) { const xs = handlers.get(name) ?? []; xs.push(fn); handlers.set(name, xs); },
  };
  await createFixerRoleRuntime(fakePi, { loadSoul: async () => "s", loadPacket: async () => "p" }).activate();
  const gate = handlers.get("tool_call")?.[0]; assert.ok(gate);
  assert.equal(gate({ toolName: "bash", input: { note: "rm -rf" } }), undefined);
  assert.equal(gate({ toolName: "bash", input: { command: 7, note: "rm -rf" } }), undefined);
  assert.equal(gate({ toolName: "other", input: { command: "rm -rf" } }), undefined);
  assert.equal(gate({ toolName: "bash", input: { command: "RM -RF git  clean" } }), undefined);
  assert.deepEqual(gate({ toolName: "bash", input: { command: "git checkout -- appears first; rm -rf appears later" } }), {
    block: true,
    reason: "Fixer blocked bash command containing forbidden literal: rm -rf",
  });
}

const manifest = await loadRawPackageManifest();
const entrypoint = resolvePackageEntrypoint(manifest);
await withHermeticHome({ prefix: "issue1-judge-probe-" }, async ({home, agentDir}) => {
  const packet = resolve(home, "packet.md"); await writeFile(packet, "# packet");
  for (const phase of ["plan", "apply"] as const) {
    const dir = resolve(home, phase); await mkdir(dir, {recursive:true});
    const faux = fauxProvider({api:`probe-${phase}`, provider:`probe-${phase}`, tokenSize:{min:1000,max:1000}});
    const nonBashMarker = resolve(dir, "nonbash.txt");
    const commandCarrier = defineTool({
      name: "command_carrier", label: "command carrier", description: "probe non-bash command field",
      parameters: Type.Object({command: Type.String()}),
      async execute() { await writeFile(nonBashMarker, "nonbash-ok"); return {content:[{type:"text" as const,text:"carrier-ok"}],details:{}}; },
    });
    await withInProcessPi({cwd:packageRoot,agentDir,faux,additionalExtensionPaths:[entrypoint],systemPrompt:"probe",mode:"print",flags:{"ak-role":"fixer","ak-fixer-phase":phase,"ak-fix-packet":packet},customTools:[commandCarrier]}, async ({session,sessionManager}) => {
      const blocked = literals.map((literal,i) => ({literal,id:`${phase}-b${i}`,path:resolve(dir,`b${i}.txt`)}));
      const harmless = resolve(dir,"harmless.txt");
      const caseVariant = resolve(dir,"case.txt");
      const spacingVariant = resolve(dir,"spacing.txt");
      const multi = resolve(dir,"multi.txt");
      faux.setResponses([
        fauxAssistantMessage([
          ...blocked.map(x => fauxToolCall("bash",{command:`printf bad > ${JSON.stringify(x.path)} # ${x.literal}`},{id:x.id})),
          fauxToolCall("bash",{command:`printf bad > ${JSON.stringify(multi)} # git checkout -- then rm -rf`},{id:`${phase}-multi`}),
          fauxToolCall("bash",{command:`printf harmless-ok > ${JSON.stringify(harmless)}`},{id:`${phase}-harmless`}),
          fauxToolCall("bash",{command:`printf case-ok > ${JSON.stringify(caseVariant)} # RM -RF GIT CLEAN`},{id:`${phase}-case`}),
          fauxToolCall("bash",{command:`printf spacing-ok > ${JSON.stringify(spacingVariant)} # rm  -rf; git  clean`},{id:`${phase}-spacing`}),
          fauxToolCall("command_carrier",{command:"rm -rf"},{id:`${phase}-carrier`}),
        ],{stopReason:"toolUse"}),
        fauxAssistantMessage("continued after blocked calls"),
      ]);
      await session.prompt("probe");
      const entries = sessionManager.getEntries();
      for (const x of blocked) {
        const r=resultFor(entries,x.id); assert.equal(r.isError,true); assert.ok(textOf(r).includes(x.literal)); await absent(x.path);
      }
      const mr=resultFor(entries,`${phase}-multi`); assert.equal(mr.isError,true); assert.ok(textOf(mr).includes("rm -rf")); assert.ok(!textOf(mr).includes("git checkout --")); await absent(multi);
      for (const [id,path,want] of [[`${phase}-harmless`,harmless,"harmless-ok"],[`${phase}-case`,caseVariant,"case-ok"],[`${phase}-spacing`,spacingVariant,"spacing-ok"]] as const) {
        assert.equal(resultFor(entries,id).isError,false); assert.equal(await readFile(path,"utf8"),want);
      }
      assert.equal(resultFor(entries,`${phase}-carrier`).isError,false); assert.equal(await readFile(nonBashMarker,"utf8"),"nonbash-ok");
      // A later prompt executes after ordinary blocked errors: no session termination.
      const later=resolve(dir,"later.txt");
      faux.setResponses([fauxAssistantMessage(fauxToolCall("bash",{command:`printf later-ok > ${JSON.stringify(later)}`},{id:`${phase}-later`}),{stopReason:"toolUse"}),fauxAssistantMessage("later done")]);
      await session.prompt("continue");
      assert.equal(resultFor(sessionManager.getEntries(),`${phase}-later`).isError,false); assert.equal(await readFile(later,"utf8"),"later-ok");
    });
  }

  // Packaged role-isolation probe: an exact literal in Coder's bash command is not Fixer-gated.
  const task=resolve(home,"task.md"); await writeFile(task,"# task");
  const marker=resolve(home,"coder-isolation.txt");
  const faux=fauxProvider({api:"probe-coder",provider:"probe-coder",tokenSize:{min:1000,max:1000}});
  await withInProcessPi({cwd:packageRoot,agentDir,faux,additionalExtensionPaths:[entrypoint],systemPrompt:"probe",mode:"print",flags:{"ak-role":"coder","ak-coder-phase":"plan","ak-coder-task":task}},async({session,sessionManager})=>{
    faux.setResponses([fauxAssistantMessage(fauxToolCall("bash",{command:`printf coder-ok > ${JSON.stringify(marker)} # rm -rf`},{id:"coder-isolation"}),{stopReason:"toolUse"}),fauxAssistantMessage("done")]);
    await session.prompt("probe isolation");
    assert.equal(resultFor(sessionManager.getEntries(),"coder-isolation").isError,false);
    assert.equal(await readFile(marker,"utf8"),"coder-ok");
  });
});
console.log("independent seatbelt probes: PASS");

})().catch((error) => { console.error(error); process.exitCode = 1; });
