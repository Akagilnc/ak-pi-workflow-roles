import { accessSync, constants, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { RecorderError, safeDiagnostic } from "./errors.ts";
import {
  assertPathNotSymlinkEscape,
  normalizeRepoRelativePath,
  requireAbsoluteExistingDirectory,
  requireCanonicalGitWorktree,
  resolveInsideRoot,
} from "./paths.ts";
import { scanString } from "./scanner.ts";

export type GitReferenceKind = "authority" | "task" | "input" | "exhibit";
export type ExternalInputKind = "authority" | "task" | "input";
export type GitReferenceDeclaration = { id:string; repositoryRoot:string; commit:string; path:string; blobOid:string; sha256:string; kind:GitReferenceKind };
export type ExternalInputDeclaration = { id:string; sourcePath:string; sha256:string; kind:ExternalInputKind };
export type ExhibitDeclaration = { id:string; sourcePath:string; sha256:string };
export type RecorderConfig = {
  version:1; archive:{repositoryRoot:string;root:string;docketId:string};
  execution:{cwd:string;environment:{inherit:boolean;overrides:Record<string,string>;unset:string[]};stdin:"inherit"};
  declarations:{gitReferences:GitReferenceDeclaration[];externalInputs:ExternalInputDeclaration[];exhibits:ExhibitDeclaration[]};
  provenance:{package:string|null;model:string|null;target:string|null};
};
export type ParsedCli = { configPath:string; childArgv:string[] };
type Location = Array<string|number>;

const FULL_SHA_RE=/^[0-9a-f]{40}$/i, SHA256_RE=/^[0-9a-f]{64}$/i, ID_RE=/^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_IDS=new Set(["receipt","audit-observation","manifest","redaction-report"]);
const RESERVED_PATHS=new Set(["receipt.json","audit-observation.json","manifest.json","redaction-report.json"]);
function isRecord(v:unknown):v is Record<string,unknown>{return typeof v==="object"&&v!==null&&!Array.isArray(v)}
function exact(v:Record<string,unknown>, keys:readonly string[]){const actual=Object.keys(v);return actual.length===keys.length&&keys.every(k=>Object.hasOwn(v,k))}
function invalid(message:string,location:Location):never{throw new RecorderError("invalid-config",message,{location})}
function stringAt(v:unknown,location:Location):string{if(typeof v!=="string"||v.length===0)invalid("value must be a non-empty string",location);return v}
function nullableStringAt(v:unknown,location:Location):string|null{if(v===null)return null;if(typeof v!=="string")invalid("value must be a string or null",location);return v}
function relativeAt(v:unknown,location:Location):string{
  const text=stringAt(v,location);
  try{return normalizeRepoRelativePath(text,"config path")}catch(error){
    if(error instanceof RecorderError&&error.code==="invalid-path")throw new RecorderError("invalid-config","config path is invalid",{cause:error,location});
    throw error;
  }
}
function closed(v:unknown,keys:readonly string[],location:Location,label:string):Record<string,unknown>{if(!isRecord(v)||!exact(v,keys))invalid(`${label} shape is invalid`,location);return v}
function idAt(v:unknown,location:Location):string{const id=stringAt(v,location);if(!ID_RE.test(id))invalid("declaration id is unlawful",location);return id}
function shaAt(v:unknown,re:RegExp,location:Location,label:string):string{const s=stringAt(v,location);if(!re.test(s))invalid(`${label} is invalid`,location);return s.toLowerCase()}
function absoluteAt(v:unknown,location:Location):string{const s=stringAt(v,location);if(!isAbsolute(s))invalid("path must be absolute",location);return s}

function parseGit(v:unknown,i:number):GitReferenceDeclaration{const p:[string,string,number]=["declarations","gitReferences",i];const r=closed(v,["id","repositoryRoot","commit","path","blobOid","sha256","kind"],p,"git reference");const k=r.kind;if(k!=="authority"&&k!=="task"&&k!=="input"&&k!=="exhibit")invalid("git reference kind is invalid",[...p,"kind"]);return{id:idAt(r.id,[...p,"id"]),repositoryRoot:absoluteAt(r.repositoryRoot,[...p,"repositoryRoot"]),commit:shaAt(r.commit,FULL_SHA_RE,[...p,"commit"],"commit"),path:relativeAt(r.path,[...p,"path"]),blobOid:shaAt(r.blobOid,FULL_SHA_RE,[...p,"blobOid"],"blob oid"),sha256:shaAt(r.sha256,SHA256_RE,[...p,"sha256"],"sha256"),kind:k}}
function parseExternal(v:unknown,i:number):ExternalInputDeclaration{const p:[string,string,number]=["declarations","externalInputs",i];const r=closed(v,["id","sourcePath","sha256","kind"],p,"external input");const k=r.kind;if(k!=="authority"&&k!=="task"&&k!=="input")invalid("external input kind is invalid",[...p,"kind"]);return{id:idAt(r.id,[...p,"id"]),sourcePath:absoluteAt(r.sourcePath,[...p,"sourcePath"]),sha256:shaAt(r.sha256,SHA256_RE,[...p,"sha256"],"sha256"),kind:k}}
function parseExhibit(v:unknown,i:number):ExhibitDeclaration{const p:[string,string,number]=["declarations","exhibits",i];const r=closed(v,["id","sourcePath","sha256"],p,"exhibit");return{id:idAt(r.id,[...p,"id"]),sourcePath:absoluteAt(r.sourcePath,[...p,"sourcePath"]),sha256:shaAt(r.sha256,SHA256_RE,[...p,"sha256"],"sha256")}}

export function parseRecorderArgv(argv:string[]):ParsedCli{if(argv.length<3)throw new RecorderError("invalid-argv");if(argv[0]!=="--config")throw new RecorderError("invalid-argv");const configPath=argv[1];if(typeof configPath!=="string"||!configPath)throw new RecorderError("invalid-argv");if(argv[2]!=="--")throw new RecorderError("invalid-argv");const childArgv=argv.slice(3);if(!childArgv.length)throw new RecorderError("invalid-argv");return{configPath,childArgv}}

export function readRecorderConfig(configPath:string):string{try{accessSync(configPath,constants.R_OK);return readFileSync(configPath,"utf8")}catch(error){const code=isRecord(error)?error.code:null;if(code==="ENOENT"||code==="EACCES"||code==="EPERM"||code==="EISDIR")throw new RecorderError("invalid-path","config path is unreadable",{cause:error,location:null,diagnostic:safeDiagnostic("config-read",error)});throw error}}

export function parseRecorderConfigStructure(text:string):RecorderConfig{
  let raw:unknown;try{raw=JSON.parse(text)}catch{invalid("config JSON is malformed",[])}
  const root=closed(raw,["version","archive","execution","declarations","provenance"],[],"config");
  if(root.version!==1)invalid("config.version must be 1",["version"]);
  const archive=closed(root.archive,["repositoryRoot","root","docketId"],["archive"],"archive");
  const execution=closed(root.execution,["cwd","environment","stdin"],["execution"],"execution");
  const environment=closed(execution.environment,["inherit","overrides","unset"],["execution","environment"],"environment");
  const declarations=closed(root.declarations,["gitReferences","externalInputs","exhibits"],["declarations"],"declarations");
  const provenance=closed(root.provenance,["package","model","target"],["provenance"],"provenance");
  if(execution.stdin!=="inherit")invalid("execution.stdin must be inherit",["execution","stdin"]);
  if(typeof environment.inherit!=="boolean")invalid("environment.inherit must be boolean",["execution","environment","inherit"]);
  if(!isRecord(environment.overrides))invalid("environment.overrides must be an object",["execution","environment","overrides"]);
  const overrides:Record<string,string>={};for(const [key,value] of Object.entries(environment.overrides)){if(typeof value!=="string")invalid("override values must be strings",["execution","environment","overrides"]);overrides[key]=value}
  if(!Array.isArray(environment.unset))invalid("environment.unset must be an array",["execution","environment","unset"]);
  const unset:string[]=[];const seenUnset=new Set<string>();for(const [i,value] of environment.unset.entries()){if(typeof value!=="string"||!value)invalid("unset entry must be a non-empty string",["execution","environment","unset",i]);if(seenUnset.has(value))invalid("unset entry is duplicated",["execution","environment","unset",i]);if(Object.hasOwn(overrides,value))invalid("unset conflicts with overrides",["execution","environment","unset",i]);seenUnset.add(value);unset.push(value)}
  for(const key of ["gitReferences","externalInputs","exhibits"] as const)if(!Array.isArray(declarations[key]))invalid("declaration collection must be an array",["declarations",key]);
  const gitReferences=(declarations.gitReferences as unknown[]).map(parseGit), externalInputs=(declarations.externalInputs as unknown[]).map(parseExternal), exhibits=(declarations.exhibits as unknown[]).map(parseExhibit);
  const repositoryRoot=absoluteAt(archive.repositoryRoot,["archive","repositoryRoot"]), archiveRoot=relativeAt(archive.root,["archive","root"]), docketId=relativeAt(archive.docketId,["archive","docketId"]), cwd=absoluteAt(execution.cwd,["execution","cwd"]);
  const indexed=[...gitReferences.map((item,i)=>({item,loc:["declarations","gitReferences",i,"id"] as Location})),...externalInputs.map((item,i)=>({item,loc:["declarations","externalInputs",i,"id"] as Location})),...exhibits.map((item,i)=>({item,loc:["declarations","exhibits",i,"id"] as Location}))];const ids=new Set<string>();for(const {item,loc} of indexed){if(RESERVED_IDS.has(item.id))invalid("declaration uses a reserved generated id",loc);if(ids.has(item.id))invalid("declaration id is duplicated",loc);ids.add(item.id)}
  const identities=new Set<string>();for(const [i,ref] of gitReferences.entries()){if(RESERVED_PATHS.has(ref.path))invalid("git reference uses a reserved generated path",["declarations","gitReferences",i,"path"]);const key=[ref.repositoryRoot,ref.commit,ref.path,ref.blobOid].join("\0");if(identities.has(key))invalid("git reference identity is duplicated",["declarations","gitReferences",i]);identities.add(key)}
  if(![...gitReferences,...externalInputs].some(x=>x.kind==="authority"))invalid("authority declaration is required",["declarations"]);if(![...gitReferences,...externalInputs].some(x=>x.kind==="task"))invalid("task declaration is required",["declarations"]);
  return{version:1,archive:{repositoryRoot,root:archiveRoot,docketId},execution:{cwd,environment:{inherit:environment.inherit,overrides,unset},stdin:"inherit"},declarations:{gitReferences,externalInputs,exhibits},provenance:{package:nullableStringAt(provenance.package,["provenance","package"]),model:nullableStringAt(provenance.model,["provenance","model"]),target:nullableStringAt(provenance.target,["provenance","target"])}}
}
export function scanRecorderConfigMetadata(config:RecorderConfig):RecorderConfig{const values:[[string,Location],...[string,Location][]]=[[config.archive.repositoryRoot,["archive","repositoryRoot"]],[config.archive.root,["archive","root"]],[config.archive.docketId,["archive","docketId"]],...config.declarations.gitReferences.map((x,i)=>[x.id,["declarations","gitReferences",i,"id"]] as [string,Location]),...config.declarations.externalInputs.map((x,i)=>[x.id,["declarations","externalInputs",i,"id"]] as [string,Location]),...config.declarations.exhibits.map((x,i)=>[x.id,["declarations","exhibits",i,"id"]] as [string,Location])];for(const [value,location] of values){const scan=scanString(value,"config metadata");if(scan.report.redacted||scan.value!==value)invalid("metadata must not be credential-shaped",location)}return config}
export function loadRecorderConfigStructure(path:string):RecorderConfig{return scanRecorderConfigMetadata(parseRecorderConfigStructure(readRecorderConfig(path)))}
export function validateRecorderConfigState(config:RecorderConfig):RecorderConfig{const repositoryRoot=requireCanonicalGitWorktree(config.archive.repositoryRoot,"archive.repositoryRoot");const destination=resolveInsideRoot(repositoryRoot,`${config.archive.root}/${config.archive.docketId}`,"archive destination");assertPathNotSymlinkEscape(destination,repositoryRoot,"archive destination");const cwd=requireAbsoluteExistingDirectory(config.execution.cwd,"execution.cwd");return{...config,archive:{...config.archive,repositoryRoot},execution:{...config.execution,cwd}}}
export function loadRecorderConfig(path:string):RecorderConfig{return validateRecorderConfigState(loadRecorderConfigStructure(path))}
export function buildChildEnv(parent:NodeJS.ProcessEnv,e:RecorderConfig["execution"]["environment"]):NodeJS.ProcessEnv{const result:NodeJS.ProcessEnv=e.inherit?{...parent}:{};for(const n of e.unset)delete result[n];for(const [n,v] of Object.entries(e.overrides))result[n]=v;return result}
