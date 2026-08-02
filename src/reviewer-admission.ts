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
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const unique = (xs: readonly unknown[]) => new Set(xs).size === xs.length;
const frozen = <T extends string>(xs: readonly T[]): readonly T[] => Object.freeze([...xs]);
const immutableRequest = (r: ReviewerCapabilityRequest): ReviewerCapabilityRequest => Object.freeze({ tools:frozen(r.tools), prerequisiteOperations:frozen(r.prerequisiteOperations) });
function request(value: unknown, ceiling: ReviewerCapabilitiesV1, hostTools: readonly string[]): ReviewerCapabilityRequest {
  if (!record(value)) fail("capability-invalid");
  const {tools,prerequisiteOperations}=value as Record<string, unknown>;
  if (!Array.isArray(tools)||!Array.isArray(prerequisiteOperations)||!tools.every(x=>typeof x==="string"&&(REVIEWER_CHILD_TOOLS as readonly string[]).includes(x))||!prerequisiteOperations.every(x=>typeof x==="string"&&(REVIEWER_PREREQUISITES as readonly string[]).includes(x))||!unique(tools)||!unique(prerequisiteOperations)||tools.some(x=>!ceiling.tools.includes(x as ReviewerChildToolName)||!hostTools.includes(x))||prerequisiteOperations.some(x=>!ceiling.prerequisiteOperations.includes(x as ReviewerPrerequisiteOperation))) fail("capability-invalid");
  return immutableRequest({tools:tools as ReviewerChildToolName[],prerequisiteOperations:prerequisiteOperations as ReviewerPrerequisiteOperation[]});
}
const SAFE_ID=/^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function admitReviewerProposal(proposal: unknown, ceiling: ReviewerCapabilitiesV1, hostTools: readonly string[]): AdmittedReviewerProposal {
  if(!record(proposal)||proposal.version!==1) fail("proposal-invalid");
  const p=proposal as Record<string, unknown>;
  if(!record(p.base)||typeof p.base.revision!=="string"||!p.base.revision) fail("base-invalid");
  const base=p.base as Record<string, unknown>;
  if(!Array.isArray(p.materials)) fail("material-invalid");
  const materialValues=p.materials as unknown[];
  const materials: MaterialSelection[]=[];
  for(const value of materialValues){if(!record(value)||typeof value.id!=="string"||!SAFE_ID.test(value.id)||typeof value.repositoryPath!=="string"||!value.repositoryPath) fail("material-invalid");const material=value as Record<string, unknown>;materials.push(Object.freeze({id:material.id as string,repositoryPath:material.repositoryPath as string}));}
  if(!unique(materials.map(x=>x.id))||!unique(materials.map(x=>x.repositoryPath.normalize("NFC")))) fail("material-invalid");
  if(!record(p.spec)||(p.spec.state!=="established"&&p.spec.state!=="not-established")) fail("spec-invalid");
  const spec=p.spec as Record<string, unknown>;
  if(!record(p.required)||p.required.standards===undefined||(spec.state==="established"&&p.required.spec===undefined)) fail("capability-invalid");
  const required=p.required as Record<string, unknown>;
  let relevanceHints: AdmittedReviewerProposal["relevanceHints"];
  if(p.relevanceHints!==undefined){if(!record(p.relevanceHints))fail("material-invalid");const hints=p.relevanceHints as Record<string, unknown>;for(const hs of [hints.standards,hints.spec])if(hs!==undefined&&(!Array.isArray(hs)||!hs.every(x=>typeof x==="string")||!unique(hs)))fail("material-invalid");relevanceHints=Object.freeze({...(hints.standards===undefined?{}:{standards:frozen(hints.standards as string[])}),...(hints.spec===undefined?{}:{spec:frozen(hints.spec as string[])})});}
  for(const op of REVIEWER_PREREQUISITES.filter(x=>x.startsWith("preflight."))) if(!ceiling.prerequisiteOperations.includes(op)) fail("prerequisite-missing");
  const standardsGrant=request(required.standards,ceiling,hostTools); const specGrant=spec.state==="established"?request(required.spec,ceiling,hostTools):undefined;
  const runner=REVIEWER_PREREQUISITES.filter(x=>x.startsWith("runner.")); for(const op of runner)if(!ceiling.prerequisiteOperations.includes(op))fail("prerequisite-missing");
  return Object.freeze({baseRevision:base.revision as string,materials:Object.freeze(materials),...(relevanceHints===undefined?{}:{relevanceHints}),standardsGrant,...(specGrant?{specGrant}:{}),prerequisiteOperations:frozen([...new Set([...standardsGrant.prerequisiteOperations,...(specGrant?.prerequisiteOperations??[]),...runner])])});
}
