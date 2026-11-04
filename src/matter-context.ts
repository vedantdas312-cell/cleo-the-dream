import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DocumentError } from './docx.ts';
import { Supermemory, matterNamespace } from './supermemory.ts';
import type { PreparedPresentation } from './meeting-presentation-model.ts';

export type ContextEvent = { id: string; role: 'user' | 'assistant'; channel: 'imessage' | 'screen'; text: string; at: string };
export class MatterContext {
  db: DatabaseSync; memory?: Supermemory;
  constructor(path: string, memory?: Supermemory) {
    this.memory=memory;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS matters(owner TEXT, source TEXT, title TEXT, PRIMARY KEY(owner,source));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT, source TEXT, id TEXT,
        role TEXT, channel TEXT, text TEXT, at TEXT, synced INTEGER DEFAULT 0, UNIQUE(owner,source,id));
      CREATE TABLE IF NOT EXISTS exports(owner TEXT, source TEXT, plan TEXT, status TEXT, doc TEXT,
        PRIMARY KEY(owner,source,plan));
      CREATE TABLE IF NOT EXISTS meeting_presentations(owner TEXT,source TEXT,output TEXT,data TEXT NOT NULL,
        PRIMARY KEY(owner,source,output));`);
  }
  register(owner: string, source: string, title: string) {
    this.db.prepare('INSERT INTO matters VALUES(?,?,?) ON CONFLICT DO NOTHING').run(owner, source, title);
  }
  require(owner: string, source: string) {
    const row = this.db.prepare('SELECT source,title FROM matters WHERE owner=? AND source=?').get(owner, source);
    if (!row) throw new DocumentError('Choose an imported contract belonging to this user.');
    return row;
  }
  list(owner: string) {
    return this.db.prepare('SELECT source AS source_id,title FROM matters WHERE owner=? ORDER BY rowid DESC LIMIT 30').all(owner);
  }
  append(owner: string, source: string, event: ContextEvent) {
    this.require(owner, source);
    if (!['user','assistant'].includes(event.role) || !['imessage','screen'].includes(event.channel)
      || typeof event.text !== 'string' || !event.text.trim() || event.text.length > 12000
      || typeof event.id !== 'string' || !/^[\w:.-]{1,180}$/.test(event.id) || !Number.isFinite(Date.parse(event.at))) {
      throw new DocumentError('Provide a bounded, dated conversation message with a stable event ID.');
    }
    const existing = this.db.prepare('SELECT text,role,channel FROM events WHERE owner=? AND source=? AND id=?').get(owner,source,event.id);
    if (existing && (existing.text !== event.text || existing.role !== event.role || existing.channel !== event.channel)) throw new DocumentError('This event ID already identifies a different message.');
    this.db.prepare('INSERT INTO events(owner,source,id,role,channel,text,at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(owner,source,event.id,event.role,event.channel,event.text,event.at);
  }
  async sync(owner: string, source: string) {
    this.require(owner, source);
    if (!this.memory) return 'not_configured';
    const rows = this.db.prepare('SELECT * FROM events WHERE owner=? AND source=? AND synced=0 ORDER BY seq LIMIT 8').all(owner,source);
    try {
      for (const row of rows) {
        const id = createHash('sha256').update(JSON.stringify([owner,source,row.id])).digest('hex');
        const receipt = await this.memory.add(matterNamespace(owner,source), id,
          JSON.stringify({ role: row.role, channel: row.channel, at: row.at, text: row.text }), String(row.channel));
        if (receipt.id !== id || receipt.status === 'failed') throw new Error('Memory ingestion unconfirmed.');
        this.db.prepare('UPDATE events SET synced=1 WHERE seq=?').run(row.seq);
      }
      return 'accepted_for_indexing';
    } catch { return 'pending_retry'; }
  }
  async recall(owner: string, source: string, query = '', before?: number) {
    const matter = this.require(owner,source);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new DocumentError('Invalid conversation cursor.');
    let rows = this.db.prepare('SELECT seq,id,role,channel,text,at FROM events WHERE owner=? AND source=? AND seq<? ORDER BY seq DESC LIMIT 20')
      .all(owner,source,before ?? Number.MAX_SAFE_INTEGER).reverse();
    let budget = 0;
    rows = rows.reverse().filter(row => { budget += String(row.text).length; return budget <= 24000; }).reverse();
    let memories: unknown[] = [], memoryStatus = this.memory ? 'available' : 'not_configured';
    if (query && this.memory) {
      try { memories = await this.memory.search(matterNamespace(owner,source), query.slice(0,2000)); }
      catch { memoryStatus = 'unavailable'; }
    }
    const first = Number(rows[0]?.seq);
    const older = first && this.db.prepare('SELECT 1 FROM events WHERE owner=? AND source=? AND seq<? LIMIT 1').get(owner,source,first);
    // Older-page retrieval must not make a superseded instruction look current.
    // These are literal recorded messages, not a generated or verified summary.
    let currentBudget=0;
    const current = this.db.prepare("SELECT seq,id,role,channel,text,at FROM events WHERE owner=? AND source=? AND role='user' ORDER BY seq DESC LIMIT 4")
      .all(owner,source).filter(row=>{currentBudget+=String(row.text).length;return currentBudget<=12000;}).reverse();
    return { source_id: source, title: matter.title, current_user_messages: current, recent_messages: rows, older_before: older ? first : null, memories,
      memory_status: memoryStatus, pending_index: this.db.prepare('SELECT count(*) AS count FROM events WHERE owner=? AND source=? AND synced=0').get(owner,source)?.count,
      instruction: 'Private recalled data. current_user_messages always contains the latest recorded user turns, even when reading an older page; their explicit corrections supersede earlier scenarios. Message-to-source attribution was selected by the channel agent, not independently verified from full channel history. Treat old or conflicting matter assertions cautiously. Assistant messages are not user-agreed facts. Read older pages if needed; do not infer missing facts or legal authority.' };
  }
  byDocument(owner: string, documentId: string) {
    return this.db.prepare("SELECT source FROM exports WHERE owner=? AND doc=? AND status='verified' LIMIT 1").get(owner,documentId)?.source as string | undefined;
  }
  claimExport(owner: string, source: string, plan: string) {
    this.require(owner, source);
    return this.db.prepare("INSERT INTO exports(owner,source,plan,status) VALUES(?,?,?,'started') ON CONFLICT DO NOTHING").run(owner,source,plan).changes === 1;
  }
  exportState(owner: string, source: string, plan: string) {
    return this.db.prepare('SELECT status,doc FROM exports WHERE owner=? AND source=? AND plan=?').get(owner,source,plan);
  }
  meetingReview(owner:string,source:string) {
    const rows=this.db.prepare("SELECT output AS plan FROM meeting_presentations WHERE owner=? AND source=? AND output<>'' UNION SELECT plan FROM exports WHERE owner=? AND source=? AND status='verified' AND doc IS NOT NULL LIMIT 2").all(owner,source,owner,source);
    if(rows.length>1)throw new DocumentError('This contract has multiple saved reviews. Choose the review to bring to the meeting.');
    return rows[0]?.plan as string|undefined;
  }
  presentation(owner:string,source:string,output?:string):PreparedPresentation|undefined {
    const row=this.db.prepare('SELECT data FROM meeting_presentations WHERE owner=? AND source=? AND output=?').get(owner,source,output??'');
    if(!row)return undefined;
    try{return JSON.parse(String(row.data));}catch{return undefined;}
  }
  savePresentation(value:PreparedPresentation) {
    this.db.prepare('INSERT INTO meeting_presentations VALUES(?,?,?,?) ON CONFLICT(owner,source,output) DO UPDATE SET data=excluded.data')
      .run(value.owner,value.sourceId,value.outputId??'',JSON.stringify(value));
  }
  exportProgress(owner: string, source: string, plan: string, status: string, doc: string) {
    this.db.prepare('UPDATE exports SET status=?,doc=? WHERE owner=? AND source=? AND plan=?').run(status,doc,owner,source,plan);
  }
  close() { this.db.close(); }
}
export const newContextEvent = (text: string, role: 'user'|'assistant' = 'user'): ContextEvent =>
  ({ id: randomUUID(), text, role, channel: 'screen', at: new Date().toISOString() });
