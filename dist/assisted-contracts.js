import { isAbsolute, resolve } from "node:path";
import publishedAssistedCallV1Schema from "../schemas/assisted-call-v1.schema.json" with { type: "json" };
import { isUuidV7 } from "./uuidv7.js";
import { PACKAGED_ROLES } from "./navigator-contracts.js";
function rec(v, keys, w) {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== keys.length || !keys.every((k) => Object.hasOwn(v, k))) throw new Error(`invalid ${w}`);
  return v;
}
function str(v, w) {
  if (typeof v !== "string" || !v) throw new Error(`invalid ${w}`);
  return v;
}
function validateAssistedCallConfigV1(value) {
  const configRecord = rec(value, ["version", "runId", "callId", "subject", "acquisition", "execution"], "assisted config");
  if (configRecord.version !== 1 || !isUuidV7(configRecord.runId) || !isUuidV7(configRecord.callId)) throw new Error("invalid assisted identity");
  const subjectRecord = rec(configRecord.subject, ["repositoryRoot", "github", "parentIssue", "children"], "subject"), githubRecord = rec(subjectRecord.github, ["owner", "name"], "github"), acquisitionRecord = rec(configRecord.acquisition, ["workspaces", "evidence", "labelPolicy"], "acquisition"), executionRecord = rec(configRecord.execution, ["workspaceId", "cwd", "role", "phase", "environment", "stdin"], "execution"), environmentRecord = rec(executionRecord.environment, ["inherit", "overrides", "unset"], "environment");
  for (const pathValue of [subjectRecord.repositoryRoot, executionRecord.cwd]) if (typeof pathValue !== "string" || !isAbsolute(pathValue) || resolve(pathValue) !== pathValue) throw new Error("paths must be canonical absolute");
  if (!Number.isSafeInteger(subjectRecord.parentIssue) || subjectRecord.parentIssue < 1 || !Array.isArray(subjectRecord.children) || !Array.isArray(acquisitionRecord.workspaces) || !Array.isArray(acquisitionRecord.evidence) || !Array.isArray(acquisitionRecord.labelPolicy)) throw new Error("invalid subject/acquisition");
  if (!PACKAGED_ROLES.includes(executionRecord.role) || executionRecord.role === "navigator") throw new Error("invalid selected role");
  if (executionRecord.role === "coder" || executionRecord.role === "fixer" ? executionRecord.phase !== "plan" && executionRecord.phase !== "apply" : executionRecord.phase !== null) throw new Error("invalid selected phase");
  if (executionRecord.stdin !== "inherit" || typeof environmentRecord.inherit !== "boolean" || !environmentRecord.overrides || typeof environmentRecord.overrides !== "object" || !Array.isArray(environmentRecord.unset)) throw new Error("invalid execution policy");
  str(githubRecord.owner, "github owner");
  str(githubRecord.name, "github name");
  const canonicalPath = (value2, where) => {
    if (typeof value2 !== "string" || !isAbsolute(value2) || resolve(value2) !== value2) throw new Error(`invalid ${where}`);
    return value2;
  };
  const workspaces = acquisitionRecord.workspaces.map((x, i) => {
    const w = rec(x, ["id", "root", "relation"], `workspace/${i}`);
    str(w.id, "workspace id");
    canonicalPath(w.root, "workspace root");
    if (w.relation !== "repository" && w.relation !== "worktree") throw new Error("invalid workspace");
    return w;
  });
  if (new Set(workspaces.map((w) => w.id)).size !== workspaces.length || !workspaces.some((w) => w.id === executionRecord.workspaceId && w.root === executionRecord.cwd)) throw new Error("selected workspace mismatch");
  const evidence = acquisitionRecord.evidence.map((x, i) => {
    const declaration = rec(x, ["id", "kind", "path", "provenance"], `evidence/${i}`), provenanceRecord = rec(declaration.provenance, ["kind", "reference"], "evidence provenance");
    str(declaration.id, "evidence id");
    str(provenanceRecord.kind, "evidence provenance kind");
    str(provenanceRecord.reference, "evidence provenance reference");
    if (!["authority", "acceptance", "task", "input"].includes(String(declaration.kind))) throw new Error("invalid evidence declaration");
    canonicalPath(declaration.path, "evidence path");
    return declaration;
  });
  if (new Set(evidence.map((declaration) => declaration.id)).size !== evidence.length) throw new Error("duplicate evidence id");
  const labelPolicy = acquisitionRecord.labelPolicy.map((x, i) => {
    const labelRecord = rec(x, ["labelId", "meaning"], `labelPolicy/${i}`);
    str(labelRecord.labelId, "label id");
    str(labelRecord.meaning, "label meaning");
    return labelRecord;
  });
  if (new Set(labelPolicy.map((x) => x.labelId)).size !== labelPolicy.length) throw new Error("duplicate label policy id");
  if (typeof environmentRecord.overrides !== "object" || Array.isArray(environmentRecord.overrides) || Object.entries(environmentRecord.overrides).some(([k, v]) => !k || k.includes("\0") || k.includes("=") || typeof v !== "string" || v.includes("\0")) || environmentRecord.unset.some((x) => typeof x !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(x)) || Object.keys(environmentRecord.overrides).some((x) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(x)) || new Set(environmentRecord.unset).size !== environmentRecord.unset.length || environmentRecord.unset.some((x) => Object.hasOwn(environmentRecord.overrides, x))) throw new Error("invalid environment policy");
  const children = subjectRecord.children;
  for (let i = 0; i < children.length; i++) {
    const childRecord = rec(children[i], ["number", "relation", "provenance"], "child"), childProvenance = rec(childRecord.provenance, ["kind", "reference"], "provenance");
    if (childRecord.relation !== "sub_issue" || !Number.isSafeInteger(childRecord.number) || childRecord.number < 1 || i > 0 && childRecord.number <= children[i - 1].number || childProvenance.kind !== "caller" && childProvenance.kind !== "tracker" || typeof childProvenance.reference !== "string" || !childProvenance.reference) throw new Error("invalid exact child set");
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
const assistedCallConfigV1Schema = publishedAssistedCallV1Schema;
export {
  assistedCallConfigV1Schema,
  validateAssistedCallConfigV1,
  validateSelectedPiArgvV1
};
