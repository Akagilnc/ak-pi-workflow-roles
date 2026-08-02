import type { ReviewerPromptIdentity } from "./reviewer-prompt-identity.ts";

export const REVIEWER_CHILD_TOOLS = ["read", "grep", "find", "ls", "bash", "write", "edit"] as const;
export const REVIEWER_PREREQUISITES = [
  "preflight.git.pin-target", "preflight.git.resolve-base", "preflight.git.derive-range",
  "preflight.git.list-ordered-commits", "preflight.git.read-material",
  "runner.git.materialize-mirror", "runner.git.materialize-workspace", "runner.git.verify-snapshot",
] as const;
export type ReviewerChildToolName = (typeof REVIEWER_CHILD_TOOLS)[number];
export type ReviewerPrerequisiteOperation = (typeof REVIEWER_PREREQUISITES)[number];
export type ReviewerCapabilityRequest = Readonly<{ tools: readonly ReviewerChildToolName[]; prerequisiteOperations: readonly ReviewerPrerequisiteOperation[] }>;
export type ReviewerCapabilitiesV1 = ReviewerCapabilityRequest & Readonly<{ version: 1; taskSha256: string; document: ReviewerPromptIdentity }>;
export type MaterialSelection = Readonly<{ id: string; repositoryPath: string }>;
export type ReviewerProposalV1 = Readonly<{ version: 1; base: Readonly<{ revision: string }>; materials: readonly MaterialSelection[]; relevanceHints?: Readonly<{ standards?: readonly string[]; spec?: readonly string[] }>; spec: Readonly<{ state: "established" | "not-established" }>; required: Readonly<{ standards: ReviewerCapabilityRequest; spec?: ReviewerCapabilityRequest }> }>;
export type AdmittedReviewerProposal = Readonly<{ baseRevision: string; materials: readonly MaterialSelection[]; relevanceHints?: Readonly<{ standards?: readonly string[]; spec?: readonly string[] }>; standardsGrant: ReviewerCapabilityRequest; specGrant?: ReviewerCapabilityRequest; prerequisiteOperations: readonly ReviewerPrerequisiteOperation[] }>;

export class ReviewerAdmissionError extends Error { constructor(readonly code: "proposal-invalid"|"base-invalid"|"material-invalid"|"spec-invalid"|"capability-invalid"|"prerequisite-missing") { super(code); } }
const fail = (code: ReviewerAdmissionError["code"]): never => { throw new ReviewerAdmissionError(code); };
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const unique = (xs: readonly unknown[]) => new Set(xs).size === xs.length;
const frozen = <T extends string>(xs: readonly T[]): readonly T[] => Object.freeze([...xs]);
const immutableRequest = (r: ReviewerCapabilityRequest): ReviewerCapabilityRequest => Object.freeze({ tools:frozen(r.tools), prerequisiteOperations:frozen(r.prerequisiteOperations) });
function request(value: unknown, ceiling: ReviewerCapabilitiesV1, hostTools: readonly string[]): ReviewerCapabilityRequest {
  if (!exact(value,["tools","prerequisiteOperations"])) fail("capability-invalid");
  const {tools,prerequisiteOperations}=value as Record<string, unknown>;
  if (!Array.isArray(tools)||!Array.isArray(prerequisiteOperations)||!tools.every(x=>typeof x==="string"&&(REVIEWER_CHILD_TOOLS as readonly string[]).includes(x))||!prerequisiteOperations.every(x=>typeof x==="string"&&(REVIEWER_PREREQUISITES as readonly string[]).includes(x))||!unique(tools)||!unique(prerequisiteOperations)||tools.some(x=>!ceiling.tools.includes(x as ReviewerChildToolName)||!hostTools.includes(x))||prerequisiteOperations.some(x=>!ceiling.prerequisiteOperations.includes(x as ReviewerPrerequisiteOperation))) fail("capability-invalid");
  return immutableRequest({tools:tools as ReviewerChildToolName[],prerequisiteOperations:prerequisiteOperations as ReviewerPrerequisiteOperation[]});
}
const SAFE_ID=/^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function admitReviewerProposal(proposal: unknown, ceiling: ReviewerCapabilitiesV1, hostTools: readonly string[]): AdmittedReviewerProposal {
  const p=proposal as ReviewerProposalV1;
  const keys=p?.relevanceHints===undefined?["version","base","materials","spec","required"]:["version","base","materials","relevanceHints","spec","required"];
  if(!exact(p,keys)||p.version!==1) fail("proposal-invalid");
  if(!exact(p.base,["revision"])||typeof p.base.revision!=="string"||!p.base.revision) fail("base-invalid");
  if(!Array.isArray(p.materials)) fail("material-invalid");
  for(const m of p.materials){if(!exact(m,["id","repositoryPath"])||typeof m.id!=="string"||!SAFE_ID.test(m.id)||typeof m.repositoryPath!=="string"||!m.repositoryPath||m.repositoryPath.startsWith("/")||m.repositoryPath.includes("\\")||/[\u0000-\u001f\u007f]/u.test(m.repositoryPath)||m.repositoryPath.split("/").some(s=>!s||s==="."||s==="..")) fail("material-invalid");}
  if(!unique(p.materials.map(x=>x.id))||!unique(p.materials.map(x=>x.repositoryPath.normalize("NFC")))) fail("material-invalid");
  if(!exact(p.spec,["state"])||(p.spec.state!=="established"&&p.spec.state!=="not-established")) fail("spec-invalid");
  const requiredKeys=p.spec.state==="established"?["standards","spec"]:["standards"];
  if(!exact(p.required,requiredKeys)) fail("capability-invalid");
  if(p.relevanceHints!==undefined){if(!exact(p.relevanceHints,Object.keys(p.relevanceHints))||Object.keys(p.relevanceHints).some(k=>k!=="standards"&&k!=="spec")) fail("material-invalid");const ids=new Set(p.materials.map(x=>x.id));for(const hs of [p.relevanceHints.standards,p.relevanceHints.spec])if(hs!==undefined&&(!Array.isArray(hs)||!hs.every(x=>typeof x==="string"&&ids.has(x))||!unique(hs)))fail("material-invalid");}
  for(const op of REVIEWER_PREREQUISITES.filter(x=>x.startsWith("preflight."))) if(!ceiling.prerequisiteOperations.includes(op)) fail("prerequisite-missing");
  const standardsGrant=request(p.required.standards,ceiling,hostTools); const specGrant=p.spec.state==="established"?request(p.required.spec,ceiling,hostTools):undefined;
  const runner=REVIEWER_PREREQUISITES.filter(x=>x.startsWith("runner.")); for(const op of runner)if(!ceiling.prerequisiteOperations.includes(op))fail("prerequisite-missing");
  return Object.freeze({baseRevision:p.base.revision,materials:Object.freeze(p.materials.map(m=>Object.freeze({...m}))),...(p.relevanceHints===undefined?{}:{relevanceHints:Object.freeze({...p.relevanceHints})}),standardsGrant,...(specGrant?{specGrant}:{}),prerequisiteOperations:frozen([...new Set([...standardsGrant.prerequisiteOperations,...(specGrant?.prerequisiteOperations??[]),...runner])])});
}
