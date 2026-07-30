import assert from 'node:assert/strict';
import { createCollectorLedger } from '/Users/akagilnc/WorkSpace/ak-pi-workflow-roles/src/collector-ledger.ts';
import { buildCollectorReceipt } from '/Users/akagilnc/WorkSpace/ak-pi-workflow-roles/src/collector-receipt.ts';
import { createGhCollectorGitHubTransport, normalizeReview } from '/Users/akagilnc/WorkSpace/ak-pi-workflow-roles/src/collector-github.ts';
import { createFakeGitHubTransport, sampleIssueComment, samplePull, sampleReview, sampleReviewComment, sampleUser } from '/Users/akagilnc/WorkSpace/ak-pi-workflow-roles/test/helpers/fake-github-transport.ts';

function config(legs:any[]=[{id:'a', expectedAuthors:['author-a'], requestBody:'review'}]) { return { repository:{display:'Acme/Widgets',canonical:'acme/widgets',owner:'acme',repo:'widgets'}, prNumber:1, manifest:{version:1 as const, legs, canonicalJson:'{}\n',digest:'a'.repeat(64),sourcePath:'/tmp/legs'} }; }
function clockAt(iso:string) { let wall=new Date(iso), mono=0; return { wallNow:()=>new Date(wall), monoNow:()=>mono, sleep:async(ms:number)=>{mono+=ms;wall=new Date(wall.getTime()+ms)}, advance:(ms:number)=>{mono+=ms;wall=new Date(wall.getTime()+ms)} }; }
const results: Record<string, unknown> = {};
async function main() {

// Contradictory terminal statuses are accepted despite exact-head qualifying review.
{
 const clock=clockAt('2024-01-01T00:00:00Z'); const transport=createFakeGitHubTransport({user:sampleUser(),pullRequest:samplePull({headOid:'H'}),reviews:[sampleReview({id:1,userLogin:'author-a',commitId:'H',submittedAt:'2024-01-01T00:01:00Z'})],issueComments:[],reviewComments:[]});
 const ledger=createCollectorLedger(config()); ledger.recordActivation(clock); clock.advance(16*60_000); const {snapshot}=await ledger.observe(transport,clock); const review=ledger.allEvidence().find(x=>x.kind==='review')!;
 const missing=buildCollectorReceipt(ledger,{legs:[{legId:'a',status:'missing',rationale:'none',evidenceRefs:[snapshot.snapshotId]}]},clock);
 const unavailable=buildCollectorReceipt(ledger,{legs:[{legId:'a',status:'unavailable',rationale:'declined',evidenceRefs:[review.evidenceId],unavailableScope:'target'}]},clock);
 results.terminalPrecedence=[missing.legs[0]?.status,unavailable.legs[0]?.status];
}
// valid preserves cross-leg refs.
{
 const clock=clockAt('2024-01-01T00:00:00Z'); const transport=createFakeGitHubTransport({user:sampleUser(),pullRequest:samplePull({headOid:'H'}),reviews:[sampleReview({id:1,userLogin:'author-a',commitId:'H'}),sampleReview({id:2,userLogin:'author-b',commitId:'H'})],issueComments:[],reviewComments:[]});
 const ledger=createCollectorLedger(config([{id:'a',expectedAuthors:['author-a']},{id:'b',expectedAuthors:['author-b']}])); ledger.recordActivation(clock); await ledger.observe(transport,clock); const a=ledger.allEvidence().find(x=>x.kind==='review'&&x.authorLogin==='author-a')!, b=ledger.allEvidence().find(x=>x.kind==='review'&&x.authorLogin==='author-b')!;
 const r=buildCollectorReceipt(ledger,{legs:[{legId:'a',status:'valid',rationale:'ok',evidenceRefs:[a.evidenceId,b.evidenceId]},{legId:'b',status:'valid',rationale:'ok',evidenceRefs:[b.evidenceId]}]},clock);
 results.crossLegValid=r.legs[0]?.evidenceRefs;
}
// Persistent target-scoped declaration survives H1->H2 and is accepted for H2.
{
 const clock=clockAt('2024-01-01T00:10:00Z'); const c=sampleIssueComment({id:1,userLogin:'author-a',body:'not reviewing H1',updatedAt:'2024-01-01T00:11:00Z'}); const transport=createFakeGitHubTransport({user:sampleUser(),pullRequest:samplePull({headOid:'H1'}),reviews:[],issueComments:[c],reviewComments:[]});
 const ledger=createCollectorLedger(config()); ledger.recordActivation(clock); await ledger.observe(transport,clock); transport.state.pullRequest=samplePull({headOid:'H2'}); await ledger.observe(transport,clock); const e=ledger.allEvidence().find(x=>x.kind==='issue_comment')!;
 const r=buildCollectorReceipt(ledger,{legs:[{legId:'a',status:'unavailable',rationale:'H1 decline reused',evidenceRefs:[e.evidenceId],unavailableScope:'target'}]},clock); results.staleTarget=r.reports.find(x=>x.kind==='terminal-fact');
}
// Re-observing an unchanged edited review restores submittedAt in modelView.
{
 const clock=clockAt('2024-01-01T00:10:00Z'); const transport=createFakeGitHubTransport({user:sampleUser(),pullRequest:samplePull({headOid:'H'}),reviews:[sampleReview({id:1,userLogin:'author-a',body:'v1',commitId:'H',submittedAt:'2024-01-01T00:00:00Z'})],issueComments:[],reviewComments:[]});
 const ledger=createCollectorLedger(config()); ledger.recordActivation(clock); await ledger.observe(transport,clock); transport.state.reviews=[sampleReview({id:1,userLogin:'author-a',body:'v2 edit',commitId:'H',submittedAt:'2024-01-01T00:00:00Z'})]; const second=await ledger.observe(transport,clock); const secondEv=(second.modelView as any).evidence.find((x:any)=>x.kind==='review'); const third=await ledger.observe(transport,clock); const thirdEv=(third.modelView as any).evidence.find((x:any)=>x.kind==='review'); results.editedReobserve={second:[secondEv.authoritativeTime,secondEv.windowRelation],third:[thirdEv.authoritativeTime,thirdEv.windowRelation]};
}
// Included snapshot has an unresolved unrelated evidence ID.
{
 const clock=clockAt('2024-01-01T00:00:00Z'); const transport=createFakeGitHubTransport({user:sampleUser({} as any),pullRequest:samplePull({headOid:'H'}),reviews:[sampleReview({id:1,userLogin:'author-a',commitId:'H'})],issueComments:[sampleIssueComment({id:50,userLogin:'stranger'})],reviewComments:[]});
 transport.state.user=sampleUser(); const ledger=createCollectorLedger(config()); ledger.recordActivation(clock); const {snapshot}=await ledger.observe(transport,clock); const review=ledger.allEvidence().find(x=>x.kind==='review')!; const stranger=ledger.allEvidence().find(x=>x.kind==='issue_comment')!; const r=buildCollectorReceipt(ledger,{legs:[{legId:'a',status:'valid',rationale:'ok',evidenceRefs:[review.evidenceId]}]},clock); results.snapshotClosure={snapshotHas:snapshot.evidenceIds.includes(stranger.evidenceId),receiptHas:r.evidenceRecords.some(x=>x.evidenceId===stranger.evidenceId)};
}
// Original line is dropped from derived report.
{
 const clock=clockAt('2024-01-01T00:00:00Z'); const transport=createFakeGitHubTransport({user:sampleUser(),pullRequest:samplePull({headOid:'H'}),reviews:[sampleReview({id:1,userLogin:'author-a',commitId:'H'})],issueComments:[],reviewComments:[sampleReviewComment({id:2,userLogin:'author-a',pullRequestReviewId:1,path:'src/x.ts',line:null,originalLine:42,commitId:'H'})]}); const ledger=createCollectorLedger(config()); ledger.recordActivation(clock); await ledger.observe(transport,clock); const review=ledger.allEvidence().find(x=>x.kind==='review')!; const r=buildCollectorReceipt(ledger,{legs:[{legId:'a',status:'valid',rationale:'ok',evidenceRefs:[review.evidenceId]}]},clock); results.originalLine=r.reports.find(x=>x.kind==='review')?.report;
}
// Authenticated-user raw profile is embedded verbatim.
{
 const clock=clockAt('2024-01-01T00:00:00Z'); const user={login:'collector',raw:{login:'collector',id:7,email:'private@example.test',plan:{name:'secret'}}}; const transport=createFakeGitHubTransport({user,pullRequest:samplePull({headOid:'H'}),reviews:[sampleReview({id:1,userLogin:'author-a',commitId:'H'})],issueComments:[],reviewComments:[]}); const ledger=createCollectorLedger(config()); ledger.recordActivation(clock); await ledger.observe(transport,clock); const review=ledger.allEvidence().find(x=>x.kind==='review')!; const r=buildCollectorReceipt(ledger,{legs:[{legId:'a',status:'valid',rationale:'ok',evidenceRefs:[review.evidenceId]}]},clock); results.authRaw=r.evidenceRecords.find(x=>x.kind==='authenticated_user')?.raw;
}
// Deleted author is rejected by normalization.
try { normalizeReview({id:1,user:null,state:'COMMENTED',body:'x',commit_id:'H',submitted_at:'2024-01-01T00:00:00Z'}); } catch(e) { results.deletedAuthor=(e as Error).message; }

// PR updatedAt changes around a missed review, but bracket accepts because identity ignores it.
{
 const clock=clockAt('2024-01-01T00:00:00Z'); let pull=0; const old=samplePull({headOid:'H',updatedAt:'2024-01-01T00:00:00Z'}), newer=samplePull({headOid:'H',updatedAt:'2024-01-01T00:15:59Z'}); const transport:any={getAuthenticatedUser:async()=>sampleUser(),getPullRequest:async()=>{pull++;return pull===1?old:newer},listPullRequestReviews:async()=>({items:[],pages:[]}),listIssueComments:async()=>({items:[],pages:[]}),listReviewComments:async()=>({items:[],pages:[]}),createIssueComment:async()=>{throw new Error('no')}}; const ledger=createCollectorLedger(config()); ledger.recordActivation(clock); clock.advance(16*60_000); const {snapshot}=await ledger.observe(transport,clock); const r=buildCollectorReceipt(ledger,{legs:[{legId:'a',status:'missing',rationale:'missed concurrent review',evidenceRefs:[snapshot.snapshotId]}]},clock); results.evidenceBracket={pullReads:pull,initialUpdatedAt:old.updatedAt,terminalUpdatedAt:newer.updatedAt,certified:r.legs[0]?.status};
}

// Pagination accepts >8 MiB before any ledger cap can run.
{
 let page=0; const body='x'.repeat(100_000); const runner=async(args:string[])=>{page++; const p=page; return {status:200,headers:p<90?{link:`<https://api.github.com/repos/a/b/pulls/1/reviews?page=${p+1}>; rel="next"`}:{},bodyText:JSON.stringify([{id:p,user:{login:'author-a'},state:'COMMENTED',body,commit_id:'H',submitted_at:'2024-01-01T00:00:00Z'}])};}; const transport=createGhCollectorGitHubTransport(runner); const got=await transport.listPullRequestReviews({owner:'a',repo:'b',prNumber:1}); results.pagination={pages:got.pages.length,materializedBytes:Buffer.byteLength(JSON.stringify(got.items))};
}
console.log(JSON.stringify(results,null,2));
}
main().catch((e)=>{ console.error(e); process.exitCode=1; });
