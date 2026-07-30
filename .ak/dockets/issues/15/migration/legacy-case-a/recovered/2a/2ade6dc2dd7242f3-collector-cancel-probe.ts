import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGhApiRunner } from '/Users/akagilnc/WorkSpace/ak-pi-workflow-roles/src/collector-github.ts';
async function main(){
 const d=await mkdtemp(join(tmpdir(),'collector-cancel-')); const gh=join(d,'gh');
 await writeFile(gh, '#!/usr/bin/env bash\nsleep 0.6\nprintf \'HTTP/1.1 200 OK\\r\\n\\r\\n[]\'\n'); await chmod(gh,0o755);
 const runner:any=createGhApiRunner({env:{...process.env,PATH:`${d}:${process.env.PATH}`}}); const ac=new AbortController(); const start=Date.now(); setTimeout(()=>ac.abort(new Error('cancelled')),30);
 const response=await runner(['api','--include','/x'],{signal:ac.signal});
 console.log(JSON.stringify({aborted:ac.signal.aborted,elapsedMs:Date.now()-start,status:response.status}));
}
main().catch(e=>{console.error(e);process.exitCode=1});
