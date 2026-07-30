import { createCollectorLedger } from '/Users/akagilnc/WorkSpace/ak-pi-workflow-roles/src/collector-ledger.ts';
import { buildCollectorReceipt } from '/Users/akagilnc/WorkSpace/ak-pi-workflow-roles/src/collector-receipt.ts';
import { createFakeGitHubTransport, samplePull, sampleReview, sampleUser } from '/Users/akagilnc/WorkSpace/ak-pi-workflow-roles/test/helpers/fake-github-transport.ts';
(async()=>{
let mono=0; let wall=new Date('2024-01-01T00:10:00Z');
const clock={wallNow:()=>new Date(wall),monoNow:()=>mono,async sleep(ms:number){mono+=ms;wall=new Date(wall.getTime()+ms)},advance(ms:number){mono+=ms;wall=new Date(wall.getTime()+ms)}};
const base=createFakeGitHubTransport({user:sampleUser(),pullRequest:samplePull({headOid:'head-c'}),reviews:[sampleReview({id:30,userLogin:'codexbot',state:'APPROVED',body:'cross-cutoff first sighting',commitId:'head-c',submittedAt:'2024-01-01T00:00:00Z'})],issueComments:[],reviewComments:[]});
const orig=base.listPullRequestReviews.bind(base);
base.listPullRequestReviews=async (input:any)=>{ clock.advance(2_000); return orig(input); };
const ledger=createCollectorLedger({repository:{display:'Acme/Widgets',canonical:'acme/widgets',owner:'acme',repo:'widgets'},prNumber:1,manifest:{version:1,legs:[{id:'codex',expectedAuthors:['codexbot']}],canonicalJson:'{}\n',digest:'d'.repeat(64),sourcePath:'/tmp/x'}});
ledger.recordActivation(clock); clock.advance(14*60_000+59_000); // observe begins 00:24:59
const out=await ledger.observe(base,clock); // reviews fetch starts only after wrapper advances to 00:25:01
const review=ledger.allEvidence().find(x=>x.kind==='review')!;
let accepted=false; try { buildCollectorReceipt(ledger,{legs:[{legId:'codex',status:'valid',rationale:'probe',evidenceRefs:[review.evidenceId]}]},clock); accepted=true; } catch (e) { console.log('receipt error',String(e)); }
console.log(JSON.stringify({deadline:ledger.deadlineTime?.toISOString(),snapshotObservedAt:out.snapshot.observedAt,snapshotCompletedAt:out.snapshot.completedAt,firstObservedAt:review.firstObservedAt,authoritativeTime:review.authoritativeTime,windowRelation:review.windowRelation,accepted},null,2));
})().catch(e=>{console.error(e);process.exit(1)});
