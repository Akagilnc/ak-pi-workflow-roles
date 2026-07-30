import { createHash } from "node:crypto";

export const REVIEWER_CHILD_TOOLS = ["read","grep","find","ls","bash","write","edit"] as const;
export const REVIEWER_PREREQUISITES = ["preflight.git.pin-target","preflight.git.resolve-base","preflight.git.derive-range","preflight.git.list-ordered-commits","preflight.git.read-material","runner.git.materialize-mirror","runner.git.materialize-workspace","runner.git.verify-snapshot"] as const;
export type ReviewerChildToolName=typeof REVIEWER_CHILD_TOOLS[number];
export type ReviewerPrerequisiteOperation=typeof REVIEWER_PREREQUISITES[number];
export type ReviewerCapabilityRequest=Readonly<{tools:readonly ReviewerChildToolName[];bashCommands:readonly string[];prerequisiteOperations:readonly ReviewerPrerequisiteOperation[]}>;
export type ReviewerCapabilitiesV1=ReviewerCapabilityRequest&Readonly<{version:1;taskSha256:string}>;
export type MaterialSelection=Readonly<{id:string;repositoryPath:string}>;
export type ReviewerProposalV1=Readonly<{version:1;base:Readonly<{revision:string}>;standardsMaterials:readonly MaterialSelection[];spec:Readonly<{state:"established";materials:readonly MaterialSelection[]}|{state:"not-established";evidence:readonly MaterialSelection[]}>;required:Readonly<{standards:ReviewerCapabilityRequest;spec?:ReviewerCapabilityRequest}>}>;
export type ReviewerPinnedTarget=Readonly<{repositoryRoot:string;targetHead:string;refs:Readonly<Record<string,string>>}>;
export type ReviewerPinnedGitReader={pin:ReviewerPinnedTarget;resolve(base:string):Promise<string>;range(base:string):Promise<{base:string;target:string;diffCommand:string;commits:readonly string[]}>;material(path:string,revision:string):Promise<Uint8Array>};
export type AcceptedReviewerLeg=Readonly<{axis:"standards"|"spec";prompt:string;utf8Length:number;sha256:string;grant:ReviewerCapabilityRequest}>;
export type AcceptedReviewerDispatch=Readonly<{identity:string;recipe:"reviewer-dispatch-v1";targetSnapshot:ReviewerPinnedTarget;range:Readonly<{base:string;target:string;diffCommand:string;commits:readonly string[]}>;legs:readonly AcceptedReviewerLeg[]}>;

type Result={status:"rejected";identity:string;violations:readonly string[]}|{status:"accepted";dispatch:AcceptedReviewerDispatch;results:unknown}|{status:"closed"};
const sha=(bytes:string|Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function exact(value:unknown,keys:string[]){return typeof value==="object"&&value!==null&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));}
function unique(values:readonly string[]){return new Set(values).size===values.length;}
export function parseReviewerCapabilities(raw:Uint8Array,task:Uint8Array):ReviewerCapabilitiesV1{
  let value:unknown; try { value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw)); } catch { throw new Error("Invalid Reviewer capabilities UTF-8 JSON"); }
  if(!exact(value,["version","taskSha256","tools","bashCommands","prerequisiteOperations"]))throw new Error("Invalid Reviewer capabilities keys");
  const v=value as any;
  if(v.version!==1||typeof v.taskSha256!=="string"||!Array.isArray(v.tools)||!Array.isArray(v.bashCommands)||!Array.isArray(v.prerequisiteOperations))throw new Error("Invalid Reviewer capabilities schema");
  if(!/^[0-9a-f]{64}$/.test(v.taskSha256)||v.taskSha256!==sha(task))throw new Error("Reviewer capabilities task digest mismatch");
  if(!v.tools.every((x:unknown)=>typeof x==="string"&&(REVIEWER_CHILD_TOOLS as readonly string[]).includes(x))||!v.bashCommands.every((x:unknown)=>typeof x==="string")||!v.prerequisiteOperations.every((x:unknown)=>typeof x==="string"&&(REVIEWER_PREREQUISITES as readonly string[]).includes(x))||!unique(v.tools)||!unique(v.bashCommands)||!unique(v.prerequisiteOperations))throw new Error("Reviewer capabilities contain unknown or duplicate values");
  if(v.bashCommands.length&&!v.tools.includes("bash"))throw new Error("Reviewer bash commands require bash tool");
  return Object.freeze({...v,tools:Object.freeze([...v.tools]),bashCommands:Object.freeze([...v.bashCommands]),prerequisiteOperations:Object.freeze([...v.prerequisiteOperations])});
}
function section(skill:string,start:string,end:string){const at=skill.indexOf(start);if(at<0)throw new Error(`Canonical Skill lacks ${start}`);const until=skill.indexOf(end,at+start.length);return skill.slice(at,until<0?skill.length:until).trim();}
function grant(request:ReviewerCapabilityRequest,ceiling:ReviewerCapabilitiesV1,host:readonly string[]){
  if(!exact(request as any,["tools","bashCommands","prerequisiteOperations"]))throw new Error("invalid capability request");
  if(!unique(request.tools)||!unique(request.bashCommands)||!unique(request.prerequisiteOperations)||request.tools.some(x=>!ceiling.tools.includes(x)||!host.includes(x))||request.bashCommands.some(x=>!ceiling.bashCommands.includes(x))||request.prerequisiteOperations.some(x=>!ceiling.prerequisiteOperations.includes(x)))throw new Error("capability requirement exceeds ceiling");
  if(request.bashCommands.length&&!request.tools.includes("bash"))throw new Error("bash command without bash");
  return Object.freeze({tools:Object.freeze([...request.tools]),bashCommands:Object.freeze([...request.bashCommands]),prerequisiteOperations:Object.freeze([...request.prerequisiteOperations])});
}
export function createReviewerDispatcher(deps:{task:Uint8Array;canonicalSkill:string;capabilities:ReviewerCapabilitiesV1;reader:ReviewerPinnedGitReader;hostTools:readonly string[];run(dispatch:AcceptedReviewerDispatch):Promise<unknown>}){
 let closed=false; const rejections:Array<Readonly<{identity:string;violations:readonly string[]}>>=[];
 return Object.freeze({get rejections(){return Object.freeze([...rejections]);},async propose(proposal:ReviewerProposalV1):Promise<Result>{
  if(closed)return {status:"closed"}; const identity=sha(JSON.stringify(proposal));
  try {
   if(!exact(proposal as any,["version","base","standardsMaterials","spec","required"])||proposal.version!==1)throw new Error("invalid proposal");
   const specMaterials=proposal.spec.state==="established"?proposal.spec.materials:proposal.spec.evidence;
   if(!proposal.standardsMaterials.length||!specMaterials.length)throw new Error("axis materials are required");
   if(proposal.spec.state==="established"&&!proposal.required.spec)throw new Error("Spec grant required");
   if(proposal.spec.state==="not-established"&&proposal.required.spec)throw new Error("no-spec cannot have Spec grant");
   const ids=[...proposal.standardsMaterials,...specMaterials].map(x=>x.id); if(!unique(ids))throw new Error("duplicate/cross-axis material identity");
   const standardsGrant=grant(proposal.required.standards,deps.capabilities,deps.hostTools); const specGrant=proposal.required.spec&&grant(proposal.required.spec,deps.capabilities,deps.hostTools);
   const base=await deps.reader.resolve(proposal.base.revision); const range=await deps.reader.range(base); if(range.base!==base||range.target!==deps.reader.pin.targetHead)throw new Error("range inconsistent with pin");
   const common=`Task-SHA256: ${sha(deps.task)}\nTask bytes:\n${Buffer.from(deps.task).toString("utf8")}\nTarget: ${range.target}\nBase: ${range.base}\nDiff: ${range.diffCommand}\nCommits:\n${range.commits.join("\n")}`;
   const material=async(items:readonly MaterialSelection[])=>Promise.all(items.map(async x=>`${x.id} (${x.repositoryPath}):\n${Buffer.from(await deps.reader.material(x.repositoryPath,range.target)).toString("utf8")}`));
   const baseline=section(deps.canonicalSkill,"## Standards baseline","## Spec review burden"); const standardsBurden=section(deps.canonicalSkill,"## Standards review burden","## Spec review burden");
   const prompts:Array<{axis:"standards"|"spec";prompt:string;grant:ReviewerCapabilityRequest}>=[];
   prompts.push({axis:"standards",grant:standardsGrant,prompt:`${common}\n\nStandards materials:\n${(await material(proposal.standardsMaterials)).join("\n\n")}\n\n${baseline}\n\n${standardsBurden}\n`});
   if(proposal.spec.state==="established")prompts.push({axis:"spec",grant:specGrant!,prompt:`${common}\n\nSpec materials:\n${(await material(proposal.spec.materials)).join("\n\n")}\n\n${section(deps.canonicalSkill,"## Spec review burden", "\n## ")}\n`});
   const legs=Object.freeze(prompts.map(x=>Object.freeze({...x,utf8Length:Buffer.byteLength(x.prompt),sha256:sha(x.prompt)}))); const dispatch=Object.freeze({identity,recipe:"reviewer-dispatch-v1" as const,targetSnapshot:deps.reader.pin,range:Object.freeze({...range,commits:Object.freeze([...range.commits])}),legs});
   closed=true; const results=await deps.run(dispatch); return {status:"accepted",dispatch,results};
  } catch(error){const violations=Object.freeze([error instanceof Error?error.message:String(error)]);rejections.push(Object.freeze({identity,violations}));return {status:"rejected",identity,violations};}
 }});
}
