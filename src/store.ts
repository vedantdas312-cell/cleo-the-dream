import { Pool } from 'pg';
import type { RedlinePlan } from './docx.ts';
import type { ImportMetadata } from './import-document.ts';
import type { DraftInput } from './draft-docx.ts';
import type { Sender } from './keiki-sender.ts';

export type Source = { id: string; owner: string; bytes: Buffer; filename: string; originalBytes?: Buffer; metadata?: ImportMetadata };
export type Output = Source & { plan: RedlinePlan; sourceId: string; outputSha256: string; previewBytes?: Buffer; previewSha256?: string };
export type Draft = Source & { input: DraftInput; outputSha256: string };
export interface Store {
  saveSender(sender: Sender): Promise<void>;
  getSender(owner: string, agentId: string, line: string): Promise<string | undefined>;
  saveSource(source: Source): Promise<void>;
  getSource(id: string, owner: string): Promise<Source | undefined>;
  saveOutput(output: Output): Promise<void>;
  getOutput(id: string, owner: string): Promise<Output | undefined>;
  listOutputIds?(owner: string, sourceId: string): Promise<string[]>;
  saveDraft(draft: Draft): Promise<void>;
  getDraft(id: string, owner: string): Promise<Draft | undefined>;
}

export class PostgresStore implements Store {
  pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10_000, query_timeout: 10_000 });
    this.pool.on('error', () => console.error('PostgreSQL idle connection lost; pool will reconnect.'));
  }
  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS cleo_senders (
        owner text NOT NULL, agent_id text NOT NULL, line text NOT NULL, phone text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (owner, agent_id, line),
        UNIQUE (phone, agent_id, line)
      );
      CREATE TABLE IF NOT EXISTS cleo_sources (
        id text NOT NULL, owner text NOT NULL, bytes bytea NOT NULL, filename text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (id, owner)
      );
      ALTER TABLE cleo_sources ADD COLUMN IF NOT EXISTS original_bytes bytea;
      ALTER TABLE cleo_sources ADD COLUMN IF NOT EXISTS metadata jsonb;
      CREATE TABLE IF NOT EXISTS cleo_redlines (
        id text NOT NULL, owner text NOT NULL, source_id text NOT NULL, bytes bytea NOT NULL,
        filename text NOT NULL, plan jsonb NOT NULL, output_sha256 text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (id, owner),
        FOREIGN KEY (source_id, owner) REFERENCES cleo_sources(id, owner)
      );
      CREATE TABLE IF NOT EXISTS cleo_drafts (
        id text NOT NULL, owner text NOT NULL, bytes bytea NOT NULL, filename text NOT NULL,
        input jsonb NOT NULL, output_sha256 text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (id, owner)
      );
      ALTER TABLE cleo_redlines ADD COLUMN IF NOT EXISTS preview_bytes bytea;
      ALTER TABLE cleo_redlines ADD COLUMN IF NOT EXISTS preview_sha256 text;`);
  }
  async saveSender(s: Sender) {
    await this.pool.query('INSERT INTO cleo_senders(owner, agent_id, line, phone) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [s.owner,s.agentId,s.line,s.phone]);
    if (await this.getSender(s.owner,s.agentId,s.line) !== s.phone) throw new Error('Sender binding conflict.');
  }
  async getSender(owner: string, agentId: string, line: string): Promise<string | undefined> {
    return (await this.pool.query('SELECT phone FROM cleo_senders WHERE owner=$1 AND agent_id=$2 AND line=$3', [owner,agentId,line])).rows[0]?.phone;
  }
  async saveSource(s: Source) {
    await this.pool.query('INSERT INTO cleo_sources(id, owner, bytes, filename, original_bytes, metadata) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [s.id, s.owner, s.bytes, s.filename, s.originalBytes ?? null, s.metadata ?? null]);
  }
  async getSource(id: string, owner: string): Promise<Source | undefined> {
    return (await this.pool.query('SELECT id, owner, bytes, filename, original_bytes AS "originalBytes", metadata FROM cleo_sources WHERE id=$1 AND owner=$2', [id, owner])).rows[0];
  }
  async saveOutput(o: Output) {
    await this.pool.query('INSERT INTO cleo_redlines(id, owner, source_id, bytes, filename, plan, output_sha256, preview_bytes, preview_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING', [o.id, o.owner, o.sourceId, o.bytes, o.filename, o.plan, o.outputSha256, o.previewBytes ?? null, o.previewSha256 ?? null]);
  }
  async getOutput(id: string, owner: string): Promise<Output | undefined> {
    return (await this.pool.query('SELECT id, owner, source_id AS "sourceId", bytes, filename, plan, output_sha256 AS "outputSha256", preview_bytes AS "previewBytes", preview_sha256 AS "previewSha256" FROM cleo_redlines WHERE id=$1 AND owner=$2', [id, owner])).rows[0];
  }
  async listOutputIds(owner:string,sourceId:string) {
    return (await this.pool.query('SELECT id FROM cleo_redlines WHERE owner=$1 AND source_id=$2 ORDER BY id', [owner,sourceId])).rows.map(row=>String(row.id));
  }
  async saveDraft(d: Draft) {
    await this.pool.query('INSERT INTO cleo_drafts(id, owner, bytes, filename, input, output_sha256) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [d.id, d.owner, d.bytes, d.filename, d.input, d.outputSha256]);
  }
  async getDraft(id: string, owner: string): Promise<Draft | undefined> {
    return (await this.pool.query('SELECT id, owner, bytes, filename, input, output_sha256 AS "outputSha256" FROM cleo_drafts WHERE id=$1 AND owner=$2', [id, owner])).rows[0];
  }
}
