import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Store, Source, Output, Draft } from './store.ts';
import type { Sender } from './keiki-sender.ts';
// A local-only alternative to Postgres, using the same owner-scoped store contract.
export class LocalStore implements Store {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path); chmodSync(path,0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS files(kind TEXT,owner TEXT,id TEXT,data TEXT,PRIMARY KEY(kind,owner,id));');
    this.db.exec('CREATE TABLE IF NOT EXISTS senders(owner TEXT,agent TEXT,line TEXT,phone TEXT,PRIMARY KEY(owner,agent,line),UNIQUE(phone,agent,line));');
  }
  async saveSender(s: Sender) {
    this.db.prepare('INSERT OR IGNORE INTO senders VALUES(?,?,?,?)').run(s.owner,s.agentId,s.line,s.phone);
    if (await this.getSender(s.owner,s.agentId,s.line) !== s.phone) throw new Error('Sender binding conflict.');
  }
  async getSender(owner: string, agentId: string, line: string): Promise<string | undefined> {
    return this.db.prepare('SELECT phone FROM senders WHERE owner=? AND agent=? AND line=?').get(owner,agentId,line)?.phone as string | undefined;
  }
  async put(kind: string, value: Source) {
    this.db.prepare('INSERT INTO files VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(kind,value.owner,value.id,JSON.stringify(value));
  }
  async get(kind: string, id: string, owner: string) {
    const row = this.db.prepare('SELECT data FROM files WHERE kind=? AND owner=? AND id=?').get(kind,owner,id);
    return row ? JSON.parse(String(row.data), (_key,value) => value?.type === 'Buffer' && Array.isArray(value.data) ? Buffer.from(value.data) : value) : undefined;
  }
  saveSource(value: Source) { return this.put('source',value); }
  getSource(id: string,owner: string): Promise<Source|undefined> { return this.get('source',id,owner); }
  saveOutput(value: Output) { return this.put('output',value); }
  getOutput(id: string,owner: string): Promise<Output|undefined> { return this.get('output',id,owner); }
  async listOutputIds(owner:string,sourceId:string) {
    return this.db.prepare("SELECT id FROM files WHERE kind='output' AND owner=? AND json_extract(data,'$.sourceId')=? ORDER BY id")
      .all(owner,sourceId).map(row=>String(row.id));
  }
  saveDraft(value: Draft) { return this.put('draft',value); }
  getDraft(id: string,owner: string): Promise<Draft|undefined> { return this.get('draft',id,owner); }
}
