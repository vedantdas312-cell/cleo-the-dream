import {sha256} from './docx.ts';
import {publicDocument,type PublicDocument} from './meeting-session.ts';

const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
// This is a fixed rendering of source-backed public fields. Never render a live Google page:
// comments, titles and other collaborators' edits can change between remote validation and capture.
export function createPresentationSnapshot(input:PublicDocument) {
  const document=publicDocument(input),documentSha256=sha256(JSON.stringify(document));
  const paragraphs=document.paragraphs.map(p=>{
    const changes=document.redlines.filter(r=>r.paragraphId===p.id).sort((a,b)=>p.text.indexOf(a.original)-p.text.indexOf(b.original));
    let cursor=0,body='';
    for(const r of changes){
      const start=p.text.indexOf(r.original),number=document.redlines.findIndex(change=>change.id===r.id)+1;
      body+=escape(p.text.slice(cursor,start))+`<span class="change" data-redline-id="${escape(r.id)}"><sup>${number}</sup><del>${escape(r.original)}</del><ins>${escape(r.replacement)}</ins></span>`;
      cursor=start+r.original.length;
    }
    return `<p id="paragraph-${escape(p.id)}">${body+escape(p.text.slice(cursor))}</p>`;
  }).join('');
  const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Saved contract review snapshot</title><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#f6f4ef;color:#222}body{padding:20px 28px;font:21px/1.5 Georgia,serif}header{height:28px;font:14px system-ui,sans-serif;color:#6b655b}main{height:calc(100% - 28px);overflow:auto;background:white}h1{font-size:25px;font-weight:500;padding:12px 18px;margin:0}p{white-space:pre-wrap;padding:12px 18px;margin:0}p.selected{background:#fff4d6;border-left:4px solid #a58230}del{color:#953d35}ins{color:#185a43;margin-left:4px}sup{font:12px system-ui,sans-serif;color:#6b655b;margin-right:5px}
</style><body data-public-snapshot="${documentSha256}"><header>Saved review snapshot · extracted contract text</header><main><h1>${escape(document.title)}</h1>${paragraphs}</main></body></html>`;
  return {document,documentSha256,html,sha256:sha256(html)};
}
