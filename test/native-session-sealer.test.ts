import assert from "node:assert/strict";
import test from "node:test";
import { Readable, Writable } from "node:stream";
import { extractAcceptedReceipt } from "../src/recorder/extract.ts";
import { RecorderError } from "../src/recorder/errors.ts";
import { forwardStream, TailRing } from "../src/recorder/spawn.ts";
const details={status:"completed",report:"done"};
function pair(id:string,isError:boolean,args:unknown=details){return [{type:"message",id:`i-${id}`,parentId:null,timestamp:new Date().toISOString(),message:{role:"assistant",content:[{type:"toolCall",id,name:"ak_coder_output",arguments:args}],stopReason:"toolUse",timestamp:Date.now()}},{type:"message",id:`r-${id}`,parentId:`i-${id}`,timestamp:new Date().toISOString(),message:{role:"toolResult",toolCallId:id,toolName:"ak_coder_output",content:[{type:"text",text:isError?"rejected":"Coder report accepted"}],isError,details:args,timestamp:Date.now()}}]}
test("matched rejected attempt may precede the one final accepted result",()=>{const rows=[...pair("bad",true),...pair("good",false)];const result=extractAcceptedReceipt(rows);assert.equal(result.receipt.toolCallId,"good")});
test("rejected attempts only are acceptance-missing",()=>{assert.throws(()=>extractAcceptedReceipt(pair("bad",true)),(e:unknown)=>e instanceof RecorderError&&e.code==="acceptance-missing")});
test("a malformed rejection is acceptance-invalid",()=>{const rows=pair("bad",true);(rows[1]!.message as Record<string,unknown>).toolCallId="other";assert.throws(()=>extractAcceptedReceipt(rows),(e:unknown)=>e instanceof RecorderError&&e.code==="acceptance-invalid")});
test("stream forwarding remains bounded beyond 2 GiB logical bytes",async()=>{const chunk=Buffer.alloc(1024*1024,7),count=2049;let bytes=0;const source=Readable.from((function*(){for(let i=0;i<count;i++)yield chunk})());const sink=new Writable({highWaterMark:1024,write(c,_e,done){bytes+=c.length;setImmediate(done)}});const ring=new TailRing();await forwardStream(source,sink,ring);assert.equal(bytes,2049*1024*1024);assert.equal(ring.bytes().length,4096);assert.equal(ring.capacity,4096)});
