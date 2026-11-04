// Bounded, persistent sketch data. No model-generated code or markup is executed.
export function sketchRejection(error, snapshot) {
  const message = error?.message ?? 'Drawing plan rejected.';
  const code = /changed/.test(message) ? 'stale_revision'
    : /already queued/.test(message) ? 'drawing_busy'
    : /clear space|Canvas full/.test(message) ? 'layout_full'
    : /arrow|node IDs/.test(message) ? 'invalid_connector'
    : /stroke crosses/.test(message) ? 'crossing_stroke'
    : /Invalid|duplicate|Unknown element/.test(message) ? 'invalid_plan' : 'unknown';
  return { error: message, code, retryable: !['unknown', 'drawing_busy'].includes(code),
    currentRevision: snapshot.revision, canvasStatus: snapshot.status,
    recovery: code === 'stale_revision' ? 'Read the canvas and use its current revision.'
      : code === 'drawing_busy' ? 'The previous sketch has not finished. Do not queue another plan yet.'
      : 'Read the canvas and submit one corrected plan with 3-5 simple boxes and anchored arrows, no freehand strokes. Use replace for a different clause; preserve existing objects for a same-clause follow-up. Keep every box and point within the 1000-by-1000 canvas. The canvas is open; this is a rejected plan, not a missing capability.' };
}
export class SketchBook {
  revision = 0; title = ''; elements = new Map(); pending = null; active = null;
  snapshot() {
    return { revision: this.revision, title: this.title, status: this.active ? 'drawing' : this.pending ? 'queued_for_speech' : 'idle',
      elements: [...this.elements.values()], queuedCount: this.pending?.elements.length ?? 0 };
  }
  stage(patch, epoch) {
    if (patch.expectedRevision !== this.revision) throw Error('Notepad changed; read it again before updating.');
    if (this.pending || this.active) throw Error('A sketch is already queued or drawing. Read the notepad before updating.');
    if (!['append', 'replace'].includes(patch.mode) || typeof patch.title !== 'string' || patch.title.length > 100
      || !Array.isArray(patch.elements) || patch.elements.length > 16 || !Array.isArray(patch.removeIDs) || patch.removeIDs.length > 32) throw Error('Invalid sketch update.');
    const ids = new Set();
    for (const [index, element] of patch.elements.entries()) {
      const problem = elementProblem(element);
      if (problem) throw Error(`Invalid sketch element ${index}: ${problem}`);
      if (ids.has(element.id)) throw Error(`Invalid sketch element ${index}: duplicate id`);
      ids.add(element.id);
    }
    if (patch.removeIDs.some(id => typeof id !== 'string' || !this.elements.has(id))) throw Error('Unknown element to remove.');
    const next = patch.mode === 'replace' ? new Map() : new Map(this.elements);
    for (const id of patch.removeIDs) next.delete(id);
    for (const element of patch.elements) next.set(element.id, element);
    if (next.size > 48) throw Error('Canvas full. Simplify the existing sketch first.');
    const base = patch.mode === 'replace' ? [] : [...this.elements.values()].filter(e => !patch.removeIDs.includes(e.id));
    const arranged = arrange(patch.elements, base);
    this.pending = structuredClone({ ...patch, elements: arranged, epoch });
    return { ok: true, status: 'queued_for_speech', revision: this.revision, queuedCount: arranged.length, layoutAdjusted: true, instruction: 'Explain the clause now. This receipt means prepared, not drawn. Say the substantive point only; do not say I have added, drawn or finished anything. Speaker playback starts the drawing.' };
  }
  begin(epoch) {
    if (!this.pending || this.pending.epoch !== epoch || this.active) return null;
    const patch = this.pending; this.pending = null;
    if (patch.mode === 'replace') this.elements.clear();
    for (const id of patch.removeIDs) this.elements.delete(id);
    this.title = patch.title; this.revision++;
    this.active = { epoch, revision: this.revision, remaining: patch.elements.map(e => e.id) };
    return { ...patch, revision: this.revision };
  }
  drawn(element, revision) {
    if (revision !== this.active?.revision || !this.active.remaining.includes(element.id)) return false;
    this.elements.set(element.id, element);
    this.active.remaining = this.active.remaining.filter(id => id !== element.id);
    return true;
  }
  finish(revision) { if (revision === this.active?.revision) this.active = null; }
  pause() { this.pending = null; this.active = null; return this.snapshot(); }
}

export function validElement(e) {
  return elementProblem(e) === null;
}
export function elementProblem(e) {
  if (!e || typeof e !== 'object' || !/^[a-zA-Z0-9_-]{1,40}$/.test(e.id)
    || !['label', 'rectangle', 'ellipse', 'arrow', 'stroke'].includes(e.kind)
    || !['ink', 'mint', 'red', 'blue'].includes(e.color)
    || typeof e.text !== 'string' || e.text.length > 100
    || !Array.isArray(e.points) || e.points.length > 48) return 'check id, kind, color, text (at most 100 characters), and points array';
  for (const key of ['x', 'y', 'width', 'height']) if (!Number.isFinite(e[key]) || e[key] < 0 || e[key] > 1000) return `${key} must be between 0 and 1000`;
  if (e.x + e.width > 1000 || e.y + e.height > 1000) return 'x + width and y + height must each be at most 1000';
  if (e.kind === 'label' && (!e.text.trim() || e.width < 80 || e.height < 30)) return 'labels need text, width >= 80 and height >= 30';
  if (['rectangle', 'ellipse'].includes(e.kind) && (e.width < 10 || e.height < 10)) return 'boxes need width and height >= 10';
  if (e.kind === 'stroke' && e.points.length < 2) return 'strokes need at least two points';
  if (e.kind === 'arrow' && (typeof e.fromID !== 'string' || typeof e.toID !== 'string' || !e.fromID || !e.toID || e.fromID === e.toID)) return 'arrows need two distinct nonempty node IDs';
  if (!e.points.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1000 && p.y >= 0 && p.y <= 1000)) return 'points must lie within the canvas';
  return null;
}

// Keep existing nodes stable, place new nodes in free space, and derive arrows
// from final node bounds rather than trusting model-chosen line endpoints.
export function arrange(incoming, existing = []) {
  let additions = structuredClone(incoming);
  // Models sometimes return a caption and its containing box separately.
  // Keep that relationship before spacing objects, so the label cannot drift away.
  const merged=new Map();
  for(const box of additions.filter(e=>['rectangle','ellipse'].includes(e.kind)&&!e.text)) {
    const labels=additions.filter(e=>e.kind==='label'&&!merged.has(e.id)&&!existing.some(old=>old.id===e.id)
      && e.x+e.width/2>=box.x && e.x+e.width/2<=box.x+box.width
      && e.y+e.height/2>=box.y && e.y+e.height/2<=box.y+box.height);
    if(labels.length===1){box.text=labels[0].text;merged.set(labels[0].id,box.id);}
  }
  additions=additions.filter(e=>!merged.has(e.id));
  for(const e of additions){e.fromID=merged.get(e.fromID)??e.fromID;e.toID=merged.get(e.toID)??e.toID;}
  const all = new Map(existing.map(e => [e.id, structuredClone(e)]));
  const occupied = existing.filter(e => isNode(e) && !additions.some(n => n.id === e.id));
  for(const e of additions.filter(isNode)) {
    e.width=Math.min(880,e.width);e.height=Math.min(880,e.height);
    if(e.text) {
      e.width=Math.min(880,Math.max(e.width,180,Math.max(...e.text.split(/\s+/).map(w=>w.length))*15+24));
      e.height=Math.min(500,Math.max(e.height,80,Math.ceil(e.text.length/Math.max(10,Math.floor((e.width-24)/16)))*36+24));
    }
    e.x=Math.max(60,Math.min(940-e.width,e.x));e.y=Math.max(60,Math.min(940-e.height,e.y));
    let found=false;
    const initialY=e.y;
    for(const x of [e.x,...occupied.map(n=>n.x+n.width+32),60,520]) {
      if(x+e.width>940)continue;
      const positions=[initialY,...Array.from({length:37},(_,i)=>60+i*24)];
      for(const y of positions) {
        if(y+e.height>940)continue;
        const candidate={...e,x,y};
        if(!occupied.some(other=>overlap(candidate,other,24))) {e.x=x;e.y=y;found=true;break;}
      }
      if(found)break;
    }
    if(!found)throw Error('No clear space for this diagram. Use fewer, shorter labels or ask to start a new sketch.');
    occupied.push(e);all.set(e.id,e);
  }
  for(const e of additions.filter(e=>!isNode(e)))all.set(e.id,e);
  for(const e of all.values()) {
    if(e.kind==='stroke' && e.points.slice(1).some((p,i)=>occupied.some(n=>overlap({
      x:Math.min(p.x,e.points[i].x)-1,y:Math.min(p.y,e.points[i].y)-1,
      width:Math.abs(p.x-e.points[i].x)+2,height:Math.abs(p.y-e.points[i].y)+2},n,6)))) {
      throw Error('A freehand stroke crosses a text box. Remove that stroke or connect the boxes with anchored arrows instead.');
    }
  }
  const changed = new Set(additions.map(e=>e.id));
  for(const e of all.values()) {
    if(e.kind!=='arrow')continue;
    const from=all.get(e.fromID), to=all.get(e.toID);
    if(!from || !to || !isNode(from) || !isNode(to))throw Error('Connect arrows using existing node IDs.');
    const route=connect(from,to,occupied);
    if(changed.has(e.id)||JSON.stringify(e.points)!==JSON.stringify(route)) {
      e.points=route;e.text='';
      if(!changed.has(e.id)){additions.push(e);changed.add(e.id);}
    }
  }
  return additions.map(e=>all.get(e.id)).sort((a,b)=>Number(a.kind==='arrow')-Number(b.kind==='arrow'));
}
const isNode = e => ['label','rectangle','ellipse'].includes(e.kind);
const overlap = (a,b,gap=0) => a.x < b.x+b.width+gap && a.x+a.width+gap > b.x && a.y < b.y+b.height+gap && a.y+a.height+gap > b.y;
function connect(a,b,nodes) {
  const ax=a.x+a.width/2,ay=a.y+a.height/2,bx=b.x+b.width/2,by=b.y+b.height/2;
  let points;
  if(Math.abs(bx-ax)>=Math.abs(by-ay)) {
    const s={x:bx>ax?a.x+a.width+10:a.x-10,y:ay},t={x:bx>ax?b.x-10:b.x+b.width+10,y:by},mid=(s.x+t.x)/2;
    points=[s,{x:mid,y:s.y},{x:mid,y:t.y},t];
  } else {
    const s={x:ax,y:by>ay?a.y+a.height+10:a.y-10},t={x:bx,y:by>ay?b.y-10:b.y+b.height+10},mid=(s.y+t.y)/2;
    points=[s,{x:s.x,y:mid},{x:t.x,y:mid},t];
  }
  const clear=(s,t)=>!nodes.some(n=>overlap({x:Math.min(s.x,t.x)-1,y:Math.min(s.y,t.y)-1,
    width:Math.abs(s.x-t.x)+2,height:Math.abs(s.y-t.y)+2},n,6));
  if(points.slice(1).some((p,i)=>!clear(points[i],p))) {
    // Orthogonal visibility grid: every segment is checked against every box,
    // including the endpoints' boxes. A detour must not cut through its own label.
    const s=points[0],t=points.at(-1);
    const xs=[...new Set([20,980,s.x,t.x,...nodes.flatMap(n=>[n.x-12,n.x+n.width+12])])].sort((a,b)=>a-b);
    const ys=[...new Set([20,980,s.y,t.y,...nodes.flatMap(n=>[n.y-12,n.y+n.height+12])])].sort((a,b)=>a-b);
    const key=(x,y)=>y*xs.length+x, point=k=>({x:xs[k%xs.length],y:ys[Math.floor(k/xs.length)]});
    const start=key(xs.indexOf(s.x),ys.indexOf(s.y)),end=key(xs.indexOf(t.x),ys.indexOf(t.y));
    const queue=[start],parents=new Map([[start,null]]);
    for(let i=0;i<queue.length&&!parents.has(end);i++) {
      const k=queue[i],x=k%xs.length,y=Math.floor(k/xs.length);
      for(const [nx,ny] of [[x+1,y],[x-1,y],[x,y+1],[x,y-1]]) {
        if(nx<0||ny<0||nx>=xs.length||ny>=ys.length)continue;
        const next=key(nx,ny);
        if(!parents.has(next)&&clear(point(k),point(next))) {parents.set(next,k);queue.push(next);}
      }
    }
    if(!parents.has(end))throw Error('No clear arrow path. Move the new boxes farther apart.');
    points=[];for(let k=end;k!==null;k=parents.get(k))points.unshift(point(k));
    points=points.filter((p,i,a)=>!i||i===a.length-1||!((a[i-1].x===p.x&&p.x===a[i+1].x)||(a[i-1].y===p.y&&p.y===a[i+1].y)));
  }
  return points.filter((p,i)=>!i||p.x!==points[i-1].x||p.y!==points[i-1].y);
}
