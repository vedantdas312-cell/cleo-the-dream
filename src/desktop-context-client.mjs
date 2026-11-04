// Paired context and tracked suggestions in this user's
// verified Google review copies only. No source-file or other-owner access.
export class DesktopContextClient {
  constructor(base, token, fetchImpl=fetch) {
    const url=new URL(base);
    if ((url.protocol!=='https:' && !(url.protocol==='http:' && url.hostname==='127.0.0.1')) || url.username || url.password || url.search || url.hash || url.pathname!=='/') throw new Error('Context server must be an HTTPS origin or local loopback.');
    if (!token || token.length<32) throw new Error('Missing desktop pairing token.');
    this.base=url.origin;this.token=token;this.fetch=fetchImpl;
  }
  async request(action,input={}) {
    const response=await this.fetch(`${this.base}/desktop/${action}`, {method:'POST',headers:{'Content-Type':'application/json','x-cleo-desktop-key':this.token},
      body:JSON.stringify({input}),redirect:'error',signal:AbortSignal.timeout(action === 'suggest_document' ? 65000 : action === 'read_document' ? 25000 : 8000)});
    if(!response.ok)throw new Error('Shared contract context is unavailable.');
    return response.json();
  }
  readDocument(document_id,offset=0) { return this.request('read_document',{document_id,offset}); }
  suggestDocument(input) { return this.request('suggest_document',input); }
  list() { return this.request('list'); }
  recall(_owner,source,query='',before) { return this.request('recall',{source_id:source,query,before}); }
  async byDocument(_owner,id) { return (await this.request('resolve',{document_id:id})).source_id; }
  append(_owner,source,event) { return this.request('remember',{source_id:source,events:[event]}); }
  async sync() { return 'handled_by_server'; }
}
