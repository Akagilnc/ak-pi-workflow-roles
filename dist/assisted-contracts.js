import { isAbsolute, resolve } from "node:path";
import { PACKAGED_ROLES } from "./navigator-contracts.js";
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function rec(v, keys, w) {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== keys.length || !keys.every((k) => Object.hasOwn(v, k))) throw new Error(`invalid ${w}`);
  return v;
}
function str(v, w) {
  if (typeof v !== "string" || !v) throw new Error(`invalid ${w}`);
  return v;
}
function validateAssistedCallConfigV1(value) {
  const r = rec(value, ["version", "runId", "callId", "subject", "acquisition", "execution"], "assisted config");
  if (r.version !== 1 || !UUID7.test(String(r.runId)) || !UUID7.test(String(r.callId))) throw new Error("invalid assisted identity");
  const s = rec(r.subject, ["repositoryRoot", "github", "parentIssue", "children"], "subject"), g = rec(s.github, ["owner", "name"], "github"), a = rec(r.acquisition, ["workspaces", "evidence", "labelPolicy"], "acquisition"), e = rec(r.execution, ["workspaceId", "cwd", "role", "phase", "environment", "stdin"], "execution"), env = rec(e.environment, ["inherit", "overrides", "unset"], "environment");
  for (const p of [s.repositoryRoot, e.cwd]) if (typeof p !== "string" || !isAbsolute(p) || resolve(p) !== p) throw new Error("paths must be canonical absolute");
  if (!Number.isSafeInteger(s.parentIssue) || s.parentIssue < 1 || !Array.isArray(s.children) || !Array.isArray(a.workspaces) || !Array.isArray(a.evidence) || !Array.isArray(a.labelPolicy)) throw new Error("invalid subject/acquisition");
  if (!PACKAGED_ROLES.includes(e.role) || e.role === "navigator") throw new Error("invalid selected role");
  if (e.role === "coder" || e.role === "fixer" ? e.phase !== "plan" && e.phase !== "apply" : e.phase !== null) throw new Error("invalid selected phase");
  if (e.stdin !== "inherit" || typeof env.inherit !== "boolean" || !env.overrides || typeof env.overrides !== "object" || !Array.isArray(env.unset)) throw new Error("invalid execution policy");
  str(g.owner, "github owner");
  str(g.name, "github name");
  const ws = a.workspaces.map((x, i) => {
    const w = rec(x, ["id", "root", "relation"], `workspace/${i}`);
    str(w.id, "workspace id");
    if (!isAbsolute(String(w.root)) || w.relation !== "repository" && w.relation !== "worktree") throw new Error("invalid workspace");
    return w;
  });
  if (new Set(ws.map((w) => w.id)).size !== ws.length || !ws.some((w) => w.id === e.workspaceId && w.root === e.cwd)) throw new Error("selected workspace mismatch");
  const evidence = a.evidence.map((x, i) => {
    const d = rec(x, ["id", "kind", "path", "provenance"], `evidence/${i}`), p = rec(d.provenance, ["kind", "reference"], "evidence provenance");
    str(d.id, "evidence id");
    str(p.kind, "evidence provenance kind");
    str(p.reference, "evidence provenance reference");
    if (!["authority", "acceptance", "task", "input"].includes(String(d.kind)) || !isAbsolute(String(d.path))) throw new Error("invalid evidence declaration");
    return d;
  });
  if (new Set(evidence.map((d) => d.id)).size !== evidence.length) throw new Error("duplicate evidence id");
  for (const [i, x] of a.labelPolicy.entries()) {
    const p = rec(x, ["labelId", "meaning"], `labelPolicy/${i}`);
    str(p.labelId, "label id");
    str(p.meaning, "label meaning");
  }
  if (typeof env.overrides !== "object" || Array.isArray(env.overrides) || Object.entries(env.overrides).some(([k, v]) => !k || k.includes("\0") || k.includes("=") || typeof v !== "string" || v.includes("\0")) || env.unset.some((x) => typeof x !== "string" || !x)) throw new Error("invalid environment policy");
  const children = s.children;
  for (let i = 0; i < children.length; i++) {
    const c = rec(children[i], ["number", "relation", "provenance"], "child"), p = rec(c.provenance, ["kind", "reference"], "provenance");
    if (c.relation !== "sub_issue" || !Number.isSafeInteger(c.number) || i > 0 && c.number <= children[i - 1].number || p.kind !== "caller" && p.kind !== "tracker" || typeof p.reference !== "string" || !p.reference) throw new Error("invalid exact child set");
  }
  ;
  return value;
}
const OWNED = /* @__PURE__ */ new Set(["--session-dir", "--session-id", "--session", "--no-session", "--continue", "-c", "--resume", "-r"]);
function values(argv, flag) {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1]) out.push(argv[++i]);
    else if (argv[i].startsWith(`${flag}=`)) out.push(argv[i].slice(flag.length + 1));
  }
  return out;
}
function validateSelectedPiArgvV1(argv, execution) {
  if (argv.length < 2 || !/(^|\/)pi$/.test(argv[0])) throw new Error("selected command must be Pi argv");
  if (argv.some((x) => /token|secret|password|api[-_]?key/i.test(x))) throw new Error("credentials are forbidden in promoted argv");
  if (argv.some((x, i) => i > 0 && OWNED.has(x.split("=", 1)[0]))) throw new Error("session flag is Runner-owned");
  const roles = values(argv, "--ak-role");
  if (roles.length !== 1 || roles[0] !== execution.role) throw new Error("selected role conflict");
  for (const role of ["coder", "fixer"]) {
    const phases = values(argv, `--ak-${role}-phase`);
    if (execution.role === role) {
      if (phases.length !== 1 || phases[0] !== execution.phase) throw new Error("selected phase conflict");
    } else if (phases.length) throw new Error("conflicting phase flag");
  }
  return [...argv];
}
const assistedCallConfigV1Schema = { type: "object", additionalProperties: false, required: ["version", "runId", "callId", "subject", "acquisition", "execution"] };
export {
  assistedCallConfigV1Schema,
  validateAssistedCallConfigV1,
  validateSelectedPiArgvV1
};
