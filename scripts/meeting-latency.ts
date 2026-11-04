import {DatabaseSync} from 'node:sqlite';
import {summarizeMeetingLatency,type MeetingTimingRow} from '../src/meeting-latency.ts';
const path=process.argv[2]??process.env.CLEO_MEETING_DB;
if(!path)throw new Error('Usage: node scripts/meeting-latency.ts /path/to/meeting.db [session UUID]');
const db=new DatabaseSync(path,{readOnly:true});
try{
  const session=process.argv[3];
  const rows=db.prepare('SELECT session,event,at,turnId,spanId,profile,operation FROM meeting_timing_trace'+(session?' WHERE session=?':'')+' ORDER BY id').all(...(session?[session]:[])) as MeetingTimingRow[];
  console.log(JSON.stringify(summarizeMeetingLatency(rows),null,2));
}finally{db.close();}
