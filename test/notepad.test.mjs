import test from 'node:test';
import assert from 'node:assert/strict';
import { SketchBook, validElement, arrange, sketchRejection } from '../desktop/NotepadWeb/book.mjs';
const label = id => ({ id, kind: 'label', x: 60, y: 80, width: 300, height: 70, text: 'Thirty days', color: 'ink', points: [] });
const patch = (revision, elements, mode = 'append') => ({ expectedRevision: revision, title: 'Notice', mode, removeIDs: [], elements });
test('a rejected second-clause plan is recoverable and cannot destroy the first sketch', () => {
  const book = new SketchBook();
  book.stage(patch(0, [label('first')]), 1);
  const first = book.begin(1); first.elements.forEach(e => book.drawn(e, first.revision)); book.finish(first.revision);
  const before = book.snapshot();
  let failure;
  try { book.stage(patch(1, [{...label('second'), x: 999}], 'replace'), 2); }
  catch (error) { failure = sketchRejection(error, book.snapshot()); }
  assert.equal(failure.retryable, true);
  assert.equal(failure.code, 'invalid_plan');
  assert.equal(failure.currentRevision, 1);
  assert.deepEqual(book.snapshot(), before);
  book.stage(patch(1, [label('second')], 'replace'), 2);
  const second = book.begin(2); second.elements.forEach(e => book.drawn(e, second.revision)); book.finish(second.revision);
  assert.deepEqual(book.snapshot().elements.map(e => e.id), ['second']);
});
test('captions remain inside their boxes and connectors avoid intervening labels',()=>{
  const box={...label('box'),kind:'rectangle',width:350,height:140,text:''};
  const caption={...label('caption'),x:70,y:90};
  const combined=arrange([box,caption]);
  assert.equal(combined.length,1);assert.equal(combined[0].text,caption.text);
  const a={...label('a'),x:60,y:100,width:180,height:100};
  const b={...label('b'),x:750,y:100,width:180,height:100};
  const blocker={...label('middle'),x:400,y:80,width:200,height:200};
  const arrow={...label('route'),kind:'arrow',text:'',fromID:'a',toID:'b',points:[]};
  const route=arrange([arrow],[a,b,blocker])[0].points;
  assert.ok(route.length>2);
  for(let i=1;i<route.length;i++) {
    const s=route[i-1],t=route[i];
    assert.ok(!(Math.min(s.x,t.x)<600&&Math.max(s.x,t.x)>400&&Math.min(s.y,t.y)<280&&Math.max(s.y,t.y)>80));
  }
});
test('overlapping follow-up boxes are spaced and arrows follow their actual edges', () => {
  const first={...label('notice'),kind:'rectangle',height:45};
  const added={...label('payment'),kind:'rectangle',text:'Payment obligations may continue',height:45};
  const arrow={...label('link'),kind:'arrow',text:'',fromID:'notice',toID:'payment',points:[]};
  const result=arrange([first,added,arrow]);
  const [a,b,line]=result;
  assert.ok(b.y>=a.y+a.height+24);
  assert.ok(a.height>=80 && b.height>=80);
  assert.equal(line.points[0].y,a.y+a.height+10);
  assert.equal(line.points.at(-1).y,b.y-10);
  assert.throws(()=>arrange([{...arrow,toID:'missing'}],[a]),/node IDs/);
  const crossing={...label('scratch'),kind:'stroke',text:'',points:[{x:a.x,y:a.y+30},{x:a.x+a.width,y:a.y+30}]};
  assert.throws(()=>arrange([crossing],[a]),/stroke crosses/);
  const original=structuredClone(a);
  arrange([{...added,y:a.y}],[a]);
  assert.deepEqual(a,original,'Layout may not move existing nodes behind the user’s back');
});
test('sketch starts on its own speech epoch and follow-ups retain previous marks', () => {
  const book = new SketchBook(), first = label('notice');
  book.stage(patch(0, [first]), 2);
  assert.equal(book.begin(1), null);
  assert.equal(book.snapshot().elements.length, 0);
  const plan = book.begin(2);
  assert.equal(book.snapshot().status, 'drawing');
  assert.equal(book.drawn(first, plan.revision), true); book.finish(plan.revision);
  const added = label('deadline');
  book.stage(patch(1, [added]), 3); book.begin(3); book.drawn(added, 2); book.finish(2);
  assert.deepEqual(book.snapshot().elements.map(e => e.id), ['notice', 'deadline']);
  assert.throws(() => book.stage(patch(1, []), 4), /changed/);
});
test('interruption cancels queued or unfinished strokes and stale completions cannot restore them', () => {
  const book = new SketchBook(), first = label('kept'), second = label('cancelled');
  book.stage(patch(0, [first, second]), 1); book.begin(1); book.drawn(first, 1); book.pause();
  assert.equal(book.drawn(second, 1), false);
  assert.deepEqual(book.snapshot().elements, [first]);
  book.stage(patch(1, [second]), 2); book.pause(); assert.equal(book.begin(2), null);
});
test('revision checked replacement, removals and validation keep model data bounded', () => {
  const book = new SketchBook(); book.stage(patch(0, [label('one')]), 1); book.begin(1); book.drawn(label('one'), 1); book.finish(1);
  book.stage(patch(1, [label('two')], 'replace'), 2); book.begin(2); book.drawn(label('two'), 2); book.finish(2);
  assert.deepEqual(book.snapshot().elements.map(e => e.id), ['two']);
  assert.throws(() => book.stage({ ...patch(2, []), removeIDs: ['missing'] }, 3), /Unknown/);
  assert.throws(() => book.stage(patch(2, [label('same'), label('same')]), 3), /duplicate/);
  assert.equal(validElement({ ...label('x'), x: Infinity }), false);
  assert.equal(validElement({ ...label('x'), width: 999 }), false);
  assert.equal(validElement({ ...label('x'), kind: 'script' }), false);
  book.stage({ ...patch(2, []), removeIDs: ['two'] }, 3); book.begin(3); book.finish(3);
  assert.deepEqual(book.snapshot().elements, []);
});

test('compiled clause diagrams pass the actual renderer, begin with speech and preserve a completed sketch after rejection',async()=>{
 const {compileDiagram}=await import('../src/notepad-tool.mjs');
 const book=new SketchBook();
 const args={expectedRevision:0,title:'Notice',mode:'replace',nodes:[{id:'notice',label:'Written notice'},{id:'period',label:'Thirty days'},{id:'end',label:'Engagement ends'}],links:[{fromID:'notice',toID:'period'},{fromID:'period',toID:'end'}]};
 const plan=compileDiagram(args);
 assert.equal(book.stage(plan,1).queuedCount,5);
 assert.equal(book.snapshot().elements.length,0);
 const active=book.begin(1);
 for(const e of active.elements)book.drawn(e,active.revision);
 book.finish(active.revision);
 assert.equal(book.snapshot().elements.length,5);
 assert.throws(()=>compileDiagram({...args,links:[{fromID:'notice',toID:'unknown'}]}),/different IDs/);
 assert.equal(book.snapshot().elements.length,5);
 const invalid={...plan,expectedRevision:1,elements:[{...plan.elements[0],x:990,width:100}]};
 assert.throws(()=>book.stage(invalid,2),/element 0: x \+ width/);
});
