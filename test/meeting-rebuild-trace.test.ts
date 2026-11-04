import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingTrace } from '../src/meeting-trace.ts';

test('durable trace keeps bounded timing markers and rejects arbitrary private content', async () => {
  const directory = await mkdtemp(join(tmpdir(),'cleo-trace-'));
  const path = join(directory,'trace.db');
  const binding = {owner:'PRIVATE_OWNER',sourceId:'PRIVATE_SOURCE',sessionId:'12345678-1234-1234-1234-123456789012'};
  const trace = new MeetingTrace(path);
  try {
    trace.record(binding,'PRIVATE_MESSAGE_SENTINEL');
    for (let index = 0; index < 250; index++) trace.record(binding,'meeting_voice_first_frame_sent',1000+index);
    trace.record(binding,'meeting_voice_error: SECRET_KEY');
    trace.close();
    const db = new DatabaseSync(path,{readOnly:true});
    try {
      const rows = db.prepare('SELECT * FROM meeting_runtime_trace ORDER BY id').all();
      assert.equal(rows.length,200);
      assert.equal(rows[0].at,1050);
      assert.equal(rows.at(-1)!.at,1249);
      assert.doesNotMatch(JSON.stringify(rows),/PRIVATE|SECRET/);
      assert.deepEqual(Object.keys(rows[0]).sort(),['at','event','id','session']);
    } finally { db.close(); }
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('correlated timings persist across reopen without exporting caller supplied payloads',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'cleo-timing-')),path=join(directory,'trace.db');
 const binding={owner:'PRIVATE_OWNER',sourceId:'PRIVATE_SOURCE',sessionId:'12345678-1234-1234-1234-123456789012'};
 try{
  const trace=new MeetingTrace(path);
  trace.record(binding,'meeting_voice_response_created',100,{turnId:binding.sessionId,spanId:binding.sessionId,profile:'server_300',text:'PRIVATE_TRANSCRIPT',audio:'PRIVATE_AUDIO',operation:'SECRET_TOOL'} as any);
  trace.record(binding,'meeting_tool_started',110,{turnId:'SECRET_TURN'});
  trace.close();const reopened=new MeetingTrace(path);reopened.close();
  const db=new DatabaseSync(path,{readOnly:true});
  try{const rows=db.prepare('SELECT * FROM meeting_timing_trace').all();assert.equal(rows.length,1);assert.equal(rows[0].profile,'server_300');assert.equal(rows[0].operation,'');assert.doesNotMatch(JSON.stringify(rows),/PRIVATE|SECRET/);}finally{db.close();}
 }finally{await rm(directory,{recursive:true,force:true});}
});
