import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { LocalStore } from '../src/local-store.ts';
import { MatterContext } from '../src/matter-context.ts';
import { Supermemory } from '../src/supermemory.ts';
import { GoogleRedline } from '../src/google-redline.ts';
import { googleToken } from '../src/google-auth.mjs';
import { Workflow } from '../src/workflow.ts';
import { importDocument } from '../src/import-document.ts';
import { sha256 } from '../src/docx.ts';
const required=(name:string)=>{const v=process.env[name];if(!v)throw new Error(`Run local:setup first; missing ${name}.`);return v;};
const store=new LocalStore(required('CLEO_LOCAL_DB'));
const matter=new MatterContext(required('CLEO_CONTEXT_DB'),process.env.SUPERMEMORY_API_KEY?new Supermemory(process.env.SUPERMEMORY_API_KEY):undefined);
const workflow=new Workflow(store,{localOnly:true,webhookKey:required('KEIKI_WEBHOOK_KEY'),downloadSecret:required('DOWNLOAD_SIGNING_SECRET'),
 publicUrl:required('PUBLIC_URL'),attachmentOrigins:required('KEIKI_ATTACHMENT_ORIGINS').split(',')},fetch,matter,new GoogleRedline(googleToken(),matter));
const context={phone:required('CLEO_DESKTOP_SENDER'),channel:'imessage'};
const owner=workflow.owner({input:{},context});
const [command,arg,detail]=process.argv.slice(2);
try {
 if(command==='import'&&arg){
  const originalBytes=await readFile(arg),filename=basename(arg),converted=await importDocument(originalBytes,filename);
  const hash=sha256(originalBytes),id=extname(filename).toLowerCase()==='.docx'?hash:sha256(JSON.stringify(['text-import-v2',extname(filename).toLowerCase(),hash]));
  await store.saveSource({id,owner,filename,bytes:converted.bytes,originalBytes:converted.metadata.converted?originalBytes:undefined,metadata:converted.metadata});
  matter.register(owner,id,filename);
  console.log(JSON.stringify(await workflow.pageSource({input:{source_id:id},context}),null,2));
 } else if(command==='context'&&arg&&detail){
  // Input file contains explicit user-authorized messages, never a blanket history import.
  const events=JSON.parse(await readFile(detail,'utf8'));
  console.log(JSON.stringify(await workflow.contractContext({input:{source_id:arg,events},context},true),null,2));
 } else if(command==='redline'&&arg&&detail){
  const plan=JSON.parse(await readFile(detail,'utf8'));
  console.log(JSON.stringify(await workflow.revise({input:{source_id:arg,source_sha256:plan.sourceSha256,changes:plan.changes},context}),null,2));
 } else if(command==='recall'&&arg){console.log(JSON.stringify(await workflow.contractContext({input:{source_id:arg},context}),null,2));}
 else throw new Error('Usage: local:contract import FILE | context SOURCE EVENTS_JSON | redline SOURCE PLAN_JSON | recall SOURCE');
} finally {matter.close();store.db.close();}
