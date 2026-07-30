import assert from 'node:assert/strict';
import { writeFile, rm, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { resolve } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
async function main(){
const root=process.cwd();
const temp=await mkdtemp(resolve(tmpdir(),'judge-invalid-agent-'));
const task=resolve(temp,'task.md'); await writeFile(task,'Review current HEAD against HEAD~1. No separate spec.');
const skill=await realpath(resolve(homedir(),'.agents/skills/code-review/SKILL.md'));
const faux=fauxProvider({api:'judge-invalid-agent',provider:'judge-invalid-agent',tokenSize:{min:1000,max:1000}});
let auditRecord:any;
faux.setResponses([
 ()=>fauxAssistantMessage([
   fauxToolCall('Agent',{subagent_type:'general-purpose',description:'valid',prompt:'Inspect.'},{id:'valid-leg'}),
   fauxToolCall('Agent',{subagent_type:'WRONG',description:'invalid',prompt:'Inspect.'},{id:'invalid-leg'}),
 ],{stopReason:'toolUse'}),
 fauxAssistantMessage('valid report'),
 fauxAssistantMessage(fauxToolCall('ak_reviewer_output',{status:'completed',report:'completed despite malformed sibling'},{id:'done'}),{stopReason:'toolUse'}),
 context=>{ const msg=context.messages.find((m:any)=>m.role==='user') as any; const text=typeof msg.content==='string'?msg.content:msg.content.map((p:any)=>p.text??'').join(''); const m=text.match(/<structured_execution_record>([\s\S]*?)<\/structured_execution_record>/); auditRecord=JSON.parse(m[1]); return fauxAssistantMessage(fauxToolCall('ak_reviewer_audit_decision',{status:'pass',violations:[]}),{stopReason:'toolUse'}); },
]);
const model=faux.getModel(); const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null});
runtime.registerNativeProvider({...faux.provider,auth:{[REDACTED]'offline',async resolve(){return {auth:{[REDACTED]}}}}},getModels(){return [model]}});
const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}}); const agentDir=resolve(temp,'agent');
const loader=new DefaultResourceLoader({cwd:root,agentDir,settingsManager:settings,additionalExtensionPaths:[resolve(root,'extensions/role-runtime.ts')],additionalSkillPaths:[skill],noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:'probe'}); await loader.reload(); assert.deepEqual(loader.getExtensions().errors,[]);
const sm=SessionManager.inMemory(root); const {session}=await createAgentSession({cwd:root,agentDir,model,thinkingLevel:'off',modelRuntime:runtime,resourceLoader:loader,sessionManager:sm,settingsManager:settings});
session.extensionRunner.setFlagValue('ak-role','reviewer'); session.extensionRunner.setFlagValue('ak-review-task',task); await session.bindExtensions({mode:'print'});
try { await session.prompt('Review.');
 const results=sm.getEntries().filter((e:any)=>e.type==='message'&&e.message.role==='toolResult').map((e:any)=>({id:e.message.toolCallId,name:e.message.toolName,isError:e.message.isError,details:e.message.details, text:e.message.content?.[0]?.text}));
 console.log(JSON.stringify({results,auditRecord},null,2));
} finally { await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'}); session.dispose(); await rm(temp,{recursive:true,force:true}); }
}
main().catch(e=>{console.error(e);process.exitCode=1});
