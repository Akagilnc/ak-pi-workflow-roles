import { createCollectorLedger, COLLECTOR_OBSERVE_TOOL } from '/Users/akagilnc/WorkSpace/ak-pi-workflow-roles/src/collector-ledger.ts';
import { buildCollectorReceipt } from '/Users/akagilnc/WorkSpace/ak-pi-workflow-roles/src/collector-receipt.ts';

const config:any={repository:{display:'a/b',canonical:'a/b',owner:'a',repo:'b'},prNumber:1,manifest:{version:1,legs:[{id:'bot',expectedAuthors:['bot'],requestBody:'review'}],canonicalJson:'x',digest:'a'.repeat(64),sourcePath:'x'}};
let mono=0; let wall=new Date('2024-01-01T00:10:00Z');
const clock:any={wallNow:()=>new Date(wall),monoNow:()=>mono,sleep:async(ms:number)=>{mono+=ms;wall=new Date(wall.getTime()+ms)},advance:(ms:number)=>{mono+=ms;wall=new Date(wall.getTime()+ms)}};
let head='A'; let reviews:any[]=[]; let issues:any[]=[]; let inlines:any[]=[];
const pages=(path:string,n:number)=>[{path,page:1,status:200,itemCount:n}];
const transport:any={
 getAuthenticatedUser:async()=>({login:'collector',raw:{login:'collector'}}),
 getPullRequest:async()=>({number:1,state:'OPEN',headOid:head,updatedAt:'2024-01-01T00:00:00Z',url:'u',raw:{head}}),
 listPullRequestReviews:async()=>({items:reviews,pages:pages('/reviews',reviews.length)}),
 listIssueComments:async()=>({items:issues,pages:pages('/issues',issues.length)}),
 listReviewComments:async()=>({items:inlines,pages:pages('/inline',inlines.length)}),
 createIssueComment:async(input:any)=>({kind:'success',comment:{id:99,userLogin:'collector',body:input.body,createdAt:wall.toISOString(),updatedAt:wall.toISOString(),htmlUrl:'u#99',raw:{body:input.body}}}),
};
const review=(body:string, commitId='A', submittedAt:any='2024-01-01T00:00:00Z', state='COMMENTED')=>({id:1,userLogin:'bot',state,body,commitId,submittedAt,htmlUrl:'u#r1',raw:{id:1,state,body,commit_id:commitId,submitted_at:submittedAt}});
const inline=(body:string)=>({id:11,pullRequestReviewId:1,userLogin:'bot',body,path:'x.ts',line:1,originalLine:1,side:'RIGHT',position:1,originalPosition:1,commitId:'A',originalCommitId:'A',createdAt:'2024-01-01T00:01:00Z',updatedAt:'2024-01-01T00:01:00Z',htmlUrl:'u#i11',raw:{body}});

async function main() {
// 1. Missing accepted immediately, 15 minutes early.
{
 const l=createCollectorLedger(config); l.recordActivation(clock); const {snapshot}=await l.observe(transport,clock);
 const r=buildCollectorReceipt(l,{legs:[{legId:'bot',status:'missing',rationale:'nothing yet',evidenceRefs:[snapshot.snapshotId]}]});
 console.log('EARLY_MISSING_ACCEPTED',r.legs[0]?.status,r.finalObservationTime,'mono',mono);
}

// 2. Request may be followed by output on the stale pre-request snapshot.
{
 const l=createCollectorLedger(config); l.recordActivation(clock); const {snapshot}=await l.observe(transport,clock); await l.request({legId:'bot',snapshotId:snapshot.snapshotId},transport,clock);
 const r=buildCollectorReceipt(l,{legs:[{legId:'bot',status:'missing',rationale:'stale',evidenceRefs:[snapshot.snapshotId]}]});
 console.log('POST_REQUEST_STALE_OUTPUT_ACCEPTED',r.requestAttempts[0]?.status,r.finalSnapshotId===snapshot.snapshotId);
}

// 3. Prior inline finding disappears from reports once absent from the final snapshot.
{
 reviews=[review('review A')]; inlines=[inline('prior inline finding')]; head='A';
 const l=createCollectorLedger(config); l.recordActivation(clock); await l.observe(transport,clock);
 head='B'; reviews=[{...review('review B','B','2024-01-01T00:02:00Z','APPROVED'),id:2,raw:{id:2}}]; inlines=[];
 await l.observe(transport,clock); const current=l.allEvidence().find((e:any)=>e.kind==='review'&&e.commitOid==='B')!;
 const r=buildCollectorReceipt(l,{legs:[{legId:'bot',status:'valid',rationale:'B valid',evidenceRefs:[current.evidenceId]}]});
 console.log('PRIOR_INLINE_IN_RECORDS',r.evidenceRecords.some((e:any)=>e.kind==='review_comment'&&e.body==='prior inline finding'));
 console.log('PRIOR_INLINE_IN_REPORTS',r.reports.some((x:any)=>x.report.includes('prior inline finding')));
}

// 4. A post-deadline review-body version with no update timestamp is backdated to submitted_at and accepted as unavailable.
{
 head='C'; inlines=[]; reviews=[review('still working','C','2024-01-01T00:00:00Z','COMMENTED')];
 const l=createCollectorLedger(config); l.recordActivation(clock); await l.observe(transport,clock);
 clock.advance(16*60*1000); reviews=[review('I will not review this PR','C','2024-01-01T00:00:00Z','COMMENTED')]; l.noteCutoffObserved(); await l.observe(transport,clock);
 const edited=l.allEvidence().find((e:any)=>e.kind==='review'&&e.body.startsWith('I will not'))!;
 const r=buildCollectorReceipt(l,{legs:[{legId:'bot',status:'unavailable',unavailableScope:'target',rationale:'declined',evidenceRefs:[edited.evidenceId]}]});
 console.log('EDITED_AFTER_DEADLINE_RELATION',edited.windowRelation,'ACCEPTED',r.legs[0]?.status);
}

// 5. A valid Collector call plus an unknown sibling is treated as a legal batch.
{
 const l=createCollectorLedger(config);
 const d=l.evaluateBatch([{type:'toolCall',id:'ok',name:COLLECTOR_OBSERVE_TOOL},{type:'toolCall',id:'bad',name:'unknown_tool'}]);
 let began=true; try{l.beginOperational(COLLECTOR_OBSERVE_TOOL,'ok')}catch{began=false}
 console.log('UNKNOWN_SIBLING_BATCH_ALLOW',d.allow,'VALID_CALL_CAN_BEGIN',began,'FATAL',l.fatal);
}

}
main().catch((error)=>{console.error(error);process.exitCode=1});
