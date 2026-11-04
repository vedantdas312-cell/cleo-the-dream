import { createHash } from 'node:crypto';

export function conversationId({ userId, matterId, sessionId, audience }) {
  for (const value of [userId, matterId, sessionId]) {
    if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Explicit user, matter and session IDs are required.');
  }
  if (!['private', 'meeting'].includes(audience)) throw new Error('Choose private or meeting context explicitly.');
  // Stable across restarts; no raw identity or matter name in the header.
  return createHash('sha256').update(JSON.stringify([userId, matterId, sessionId, audience])).digest('hex');
}

export class Keiki {
  constructor({ apiKey, agentId, baseUrl = 'https://onkeiki.com/api/v1/openai', fetchImpl = fetch }) {
    if (typeof apiKey !== 'string' || !apiKey || /\s/u.test(apiKey)) throw new Error('Set KEIKI_API_KEY securely in the process environment.');
    if (typeof agentId !== 'string' || !agentId.trim()) throw new Error('Set KEIKI_AGENT_ID to the configured Athena agent ID.');
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Keiki base URL must be HTTPS without credentials, query or fragment.');
    this.url = `${url.href.replace(/\/$/u, '')}/chat/completions`;
    this.apiKey = apiKey;
    this.agentId = agentId;
    this.fetch = fetchImpl;
  }

  async ask({ text, scope, signal }) {
    const id = conversationId(scope);
    // Thread isolation is not proof that Keiki's automatic memory is isolated.
    if (scope.audience !== 'private') throw new Error('Live meeting turns are disabled until provider memory isolation is verified.');
    if (typeof text !== 'string' || !text.trim() || text.length > 20_000) throw new Error('Provide a nonempty message of at most 20,000 characters.');
    let response;
    try {
      response = await this.fetch(this.url, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'x-conversation-id': id },
        body: JSON.stringify({ model: this.agentId, messages: [{ role: 'user', content: text }], stream: false, tool_choice: 'none' }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('Keiki request interrupted or unavailable. No automatic retry; the turn may already have been processed.');
    }
    // Provider bodies and transport exceptions may contain private text or credentials.
    if (!response.ok) throw new Error(`Keiki returned HTTP ${response.status}. Check the agent gateway and access; no automatic retry.`);
    let data;
    try { data = await response.json(); } catch { throw new Error('Keiki returned an unreadable response. No automatic retry.'); }
    const choice = data?.choices?.[0];
    if (choice?.finish_reason !== 'stop' || choice.message?.tool_calls?.length || typeof choice.message?.content !== 'string' || !choice.message.content.trim()) {
      throw new Error('Keiki did not return a complete text answer. No tools executed by Athena; no automatic retry.');
    }
    return { text: choice.message.content, conversationId: id };
  }
}

// Official contract: POST /api/v1/developer/agents/{agentId}/notice in onkeiki.com/openapi.json.
// Notices enter the existing agent's private conversation. They are NOT delivery receipts.
export class KeikiPrivateMessenger {
  constructor({ apiKey, agentId, resolveRecipient, line, fetchImpl = fetch }) {
    if (typeof apiKey !== 'string' || !apiKey || /\s/u.test(apiKey) || typeof agentId !== 'string' || !/^[\w-]{1,200}$/u.test(agentId)
      || typeof resolveRecipient !== 'function') throw new Error('Configure a private Keiki notice key, agent and owner recipient resolver.');
    this.apiKey = apiKey; this.agentId = agentId; this.resolveRecipient = resolveRecipient; this.fetch = fetchImpl; this.line = line;
  }
  async send({ owner, text, signal }) {
    // Never accept recipient information from the planner, transcript, tool arguments, or session URL.
    let phone;
    try { phone = await this.resolveRecipient(owner); } catch { return { status: 'unavailable' }; }
    if (typeof phone !== 'string' || !/^\+[1-9]\d{7,14}$/u.test(phone)) return { status: 'not_configured' };
    if (typeof text !== 'string' || !text.trim() || text.length > 6000) throw new Error('Invalid private meeting reply.');
    if (signal?.aborted) return { status: 'cancelled' };
    try {
      const response = await this.fetch(`https://onkeiki.com/api/v1/developer/agents/${encodeURIComponent(this.agentId)}/notice`, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, text, ...(this.line ? {line:this.line} : {}) }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      });
      if ([401, 403, 404].includes(response.status)) return { status: 'not_configured' };
      if (!response.ok) return { status: 'unknown' };
      const result = await response.json();
      // Require one exact existing recipient. Never infer successful delivery from HTTP 200/202.
      if (result?.ok !== true || result.conversations !== 1 || !Array.isArray(result.results) || result.results.length !== 1
        || result.results[0].phone !== phone) return { status: 'unknown' };
      const outcome = result.results[0].outcome;
      return { status: outcome === 'queued' ? 'queued' : outcome === 'ran' ? 'accepted_for_agent' : outcome === 'unavailable' ? 'unavailable' : 'unknown' };
    } catch { return { status: 'unknown' }; } // An interrupted request may already have reached the provider; no blind retry.
  }
}
