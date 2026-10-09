import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machine, final, human, run, type HumanResponse, type Event } from "../src/index.ts";
import { conversation } from "../src/conversation.ts";
import { startMachineHost, type HostedHumanRequest } from "../src/host.ts";

function deferred<T>() { let resolve!:(value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve}; }

test("conversation retains one decision through two clarification turns",async()=>{
  const received:string[]=[];let chosen="";
  const inputs:HumanResponse[]=[{type:"question",text:"Is the data safe?"},{type:"question",text:"And rollback?"},"Approve"];
  const definition=machine({initial:"decision",states:{
    decision:conversation({prompt:"Approve this result?",choices:["Approve","Revise"],reply:(question,history)=>{
      received.push(question);assert.equal(history.filter(m=>m.role==="human").length,received.length);return `Owner answered: ${question}`;
    }},{submitted:{target:"done",actions:({event}:{event:Event})=>{chosen=String(event.value);}}}),done:final(),
  }});
  const requests:string[]=[];
  const outcome=await run(definition,{human:request=>{assert.deepEqual(request.choices,["Approve","Revise"]);assert.equal(request.discussion,true);requests.push(request.prompt);return inputs.shift()!;}});
  assert.equal(outcome.value,"done");assert.equal(chosen,"Approve");assert.deepEqual(received,["Is the data safe?","And rollback?"]);
  assert.match(requests[1]!,/Owner answered: Is the data safe/);assert.match(requests[2]!,/Owner answered: And rollback/);
});
test("question channel does not loosen choices or silently add a transition",async()=>{
  assert.throws(()=>human("Choose",{submitted:"done"},{choices:["approve"],discussion:true}),/handle a question/);
  const definition=machine({initial:"decision",states:{decision:human("Choose",{submitted:"done"},{choices:["approve"]}),done:final()}});
  await assert.rejects(run(definition,{human:()=>({type:"question",text:"Why?"})}),/supported discussion question/);
  await assert.rejects(run(definition,{human:()=>"maybe"}),/Expected one of/);
});
test("host sends questions to the Machine with distinct, current request identities",async(t)=>{
  const cwd=await mkdtemp(join(tmpdir(),"machines-conversation-"));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const fixture=join(cwd,"discussion.ts");
  await writeFile(fixture,`export const description="Tests a hosted Machine discussion without model calls.";
export default function({machine,human,operation,final}) {let question=""; return machine({initial:"waiting",states:{
waiting:human(()=>question?"Answer: "+question:"Approve?",{submitted:"done",question:{target:"thinking",actions:({event})=>{question=event.value;}}},{choices:["approve"],discussion:true}),
thinking:operation(()=>({type:"replied"}),{replied:"waiting"}),done:final()}});}`);
  let next=deferred<HostedHumanRequest>();
  const host=await startMachineHost({cwd,machine:fixture,onHumanRequest:request=>next.resolve(request)});t.after(()=>host.terminate());
  const first=await next.promise;next=deferred();
  await assert.rejects(host.ask("Why?","wrong"),/stale/);
  await assert.rejects(host.respond("Why?",first.requestId),/Expected one of/);
  await host.ask("Why?",first.requestId);const second=await next.promise;
  assert.notEqual(second.requestId,first.requestId);assert.equal(second.prompt,"Answer: Why?");assert.deepEqual(second.choices,["approve"]);
  await assert.rejects(host.respond("approve",first.requestId),/stale/);
  await host.respond("approve",second.requestId);assert.equal((await host.result).state,"done");
});
