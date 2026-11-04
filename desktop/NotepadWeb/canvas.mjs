import { SketchBook, sketchRejection } from './book.mjs';
const book = new SketchBook();
const svgNS = 'http://www.w3.org/2000/svg', drawing = document.querySelector('#drawing'), pen = document.querySelector('#pen');
const colors = { ink: '#303b35', mint: '#26856a', red: '#bc5951', blue: '#5279a5' };
let generation = 0, startedAt = 0, speechEnd = 0, clipID = 0;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
function reportActivity(phase, epoch) {
  if (Number.isInteger(epoch)) window.webkit?.messageHandlers?.sketchActivity?.postMessage({phase, epoch});
}
function element(tag, attrs = {}) {
  const node = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}
function pathFor(e) {
  const { x, y, width: w, height: h } = e;
  if (e.kind === 'rectangle') return `M ${x+6} ${y} Q ${x+w*.45} ${y-2} ${x+w} ${y+3} L ${x+w-2} ${y+h} Q ${x+w*.5} ${y+h+2} ${x} ${y+h-1} Z`;
  if (e.kind === 'ellipse') return `M ${x+w/2} ${y} a ${w/2} ${h/2} 0 1 1 -0.01 0 Z`;
  if (e.kind === 'label') return '';
  return e.points.map((p,i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
}
function make(e) {
  const group = element('g', { 'data-id': e.id, 'aria-label': e.text || e.kind });
  const d = pathFor(e);
  if (d) group.append(element('path', { d, stroke: colors[e.color] }));
  if (e.kind === 'arrow') {
    const p = e.points.at(-1), q = e.points.at(-2), angle = Math.atan2(p.y-q.y,p.x-q.x), size = 16;
    group.append(element('path', { d: `M ${p.x-size*Math.cos(angle-.5)} ${p.y-size*Math.sin(angle-.5)} L ${p.x} ${p.y} L ${p.x-size*Math.cos(angle+.5)} ${p.y-size*Math.sin(angle+.5)}`, stroke: colors[e.color] }));
  }
  if (e.text) {
    let font=30, rows;
    for (;font>=14;font-=2) {
      const maxChars=Math.max(5,Math.floor((e.width-20)/(font*.56))); rows=[];let row='';
      for(const word of e.text.split(/\s+/)) {
        if(row && (row+' '+word).length>maxChars) { rows.push(row);row=''; }
        row+=(row?' ':'')+word;
      }
      if(row)rows.push(row);
      if(rows.length*font*1.25<=e.height-12)break;
    }
    font=Math.max(14,font);
    const text = element('text', { x:e.x+10, y:e.y+font+6, fill:colors[e.color] });
    text.style.fontSize=`${font}px`;
    rows.forEach((line,i) => { const span=element('tspan',{x:e.x+10,dy:i?font*1.25:0}); span.textContent=line; text.append(span); });
    group.append(text);
  }
  return group;
}
function sync() {
  drawing.replaceChildren(...book.snapshot().elements.map(make));
  document.querySelector('#title').textContent = book.title || "Let's work it out";
  svgLabel();
}
function svgLabel() { document.querySelector('#canvas').setAttribute('aria-label', `${book.title || 'Cleo sketch'}: ${book.snapshot().elements.map(e=>e.text || e.kind).join('; ')}`); }
// WebKit can suspend animation frames in a nonactivating panel. Keep progress
// bounded using the same monotonic clock, and never run a frame twice.
function nextFrame(callback) {
  let done = false, frameID, timer;
  const run = () => {
    if (done) return;
    done = true; cancelAnimationFrame(frameID); clearTimeout(timer);
    callback(performance.now());
  };
  frameID = requestAnimationFrame(run);
  timer = setTimeout(run, 100);
}
function animate(group, token, duration) {
  const paths = [...group.querySelectorAll('path')], text = group.querySelector('text');
  const lengths = paths.map(path => path.getTotalLength());
  paths.forEach((path,i)=>{ path.style.strokeDasharray=lengths[i]; path.style.strokeDashoffset=lengths[i]; });
  let clip, box;
  if(text) {
    box=text.getBBox();
    const id=`writing-${++clipID}`, clipPath=element('clipPath',{id});
    clip=element('rect',{x:box.x-2,y:box.y-2,width:0,height:box.height+4});
    clipPath.append(clip);group.prepend(clipPath);text.setAttribute('clip-path',`url(#${id})`);
  }
  return new Promise(resolve => {
    let began;
    const frame = now => {
      if (token !== generation) { group.remove(); resolve(false); return; }
      began ??= now; const t = reducedMotion ? 1 : Math.min(1,(now-began)/duration);
      paths.forEach((path,i)=>{ path.style.strokeDashoffset=lengths[i]*(1-t); });
      if(clip) clip.setAttribute('width',(box.width+4)*t);
      if(paths.length && t<1) { const point=paths[0].getPointAtLength(lengths[0]*t); pen.setAttribute('cx',point.x); pen.setAttribute('cy',point.y); pen.setAttribute('visibility','visible'); }
      else if(box && t<1) { pen.setAttribute('cx',box.x+box.width*t);pen.setAttribute('cy',box.y+box.height);pen.setAttribute('visibility','visible'); }
      if(t<1) nextFrame(frame); else { pen.setAttribute('visibility','hidden'); resolve(true); }
    }; nextFrame(frame);
  });
}
async function draw(plan, token) {
  sync(); document.querySelector('#status').textContent='Sketching as we talk…';
  for(const [index,item] of plan.elements.entries()) {
    if(token!==generation) return;
    // Preserve an old object while its replacement is being drawn, then swap it.
    const old = [...drawing.children].find(node=>node.getAttribute('data-id')===item.id);
    const group=make(item); drawing.append(group);
    const remaining = speechEnd ? speechEnd-performance.now() : 700*(plan.elements.length-index);
    const duration = Math.max(250,Math.min(1800,remaining/(plan.elements.length-index)));
    if(!await animate(group,token,duration)) return;
    if(book.drawn(item,plan.revision)) old?.remove(); else { group.remove(); return; }
    svgLabel();
  }
  book.finish(plan.revision); document.querySelector('#status').textContent='Keep going — we can add to this.';
  reportActivity('idle', plan.epoch);
}
window.cleoSketch = {
  read: () => book.snapshot(),
  stage: ({patch,epoch}) => { try { const result=book.stage(patch,epoch); document.querySelector('#status').textContent='Preparing your sketch…'; reportActivity('queued',epoch); return result; } catch(error) {return sketchRejection(error,book.snapshot());} },
  begin: ({epoch}) => { const plan=book.begin(epoch); if(plan) { startedAt=performance.now();speechEnd=0;const token=++generation; reportActivity('drawing',epoch); draw(plan,token).catch(()=>{if(token===generation)window.cleoSketch.pause();}); } return {started:!!plan}; },
  pace: ({seconds}) => { if(book.active && Number.isFinite(seconds) && seconds>0 && seconds<120) speechEnd=startedAt+seconds*1000;return {ok:true}; },
  pause: () => { const epoch=book.active?.epoch ?? book.pending?.epoch; generation++; book.pause(); sync(); pen.setAttribute('visibility','hidden'); document.querySelector('#status').textContent='Your sketch stays here.'; reportActivity('idle',epoch); return book.snapshot(); }
};
