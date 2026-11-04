const number = { type: 'number', minimum: 0, maximum: 1000 };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const sketchProperties = {
  expectedRevision: { type: 'integer', minimum: 0 },
  title: { type: 'string', maxLength: 100 }, mode: { type: 'string', enum: ['append', 'replace'] },
  removeIDs: { type: 'array', items: { type: 'string' }, maxItems: 32 },
  elements: { type: 'array', maxItems: 16, items: object({
    id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,40}$' },
    kind: { type: 'string', enum: ['label', 'rectangle', 'ellipse', 'arrow', 'stroke'] },
    x: {...number, description:'Left edge. x + width must not exceed 1000.'}, y: {...number, description:'Top edge. y + height must not exceed 1000.'},
    width: {...number, description:'Labels >= 80; boxes >= 10. Prefer 240 for labelled boxes. Arrows use 0.'},
    height: {...number, description:'Labels >= 30; boxes >= 10. Prefer 100 for labelled boxes. Arrows use 0.'},
    text: { type: 'string', maxLength: 100 }, color: { type: 'string', enum: ['ink', 'mint', 'red', 'blue'] },
    fromID: { type: 'string', maxLength: 40 }, toID: { type: 'string', maxLength: 40 },
    points: { type: 'array', maxItems: 48, items: object({ x: number, y: number }) }
  }) }
};

// Clause explanations should not depend on the model solving geometry. This
// bounded diagram compiler feeds the same revision-checked animated renderer.
export const diagramProperties = {
  expectedRevision: {type:'integer',minimum:0},
  title: {type:'string',maxLength:100}, mode: {type:'string',enum:['append','replace']},
  nodes: {type:'array',minItems:2,maxItems:5,items:object({
    id:{type:'string',pattern:'^[a-zA-Z0-9_-]{1,40}$'}, label:{type:'string',minLength:1,maxLength:60}
  })},
  links: {type:'array',maxItems:6,items:object({fromID:{type:'string'},toID:{type:'string'}})}
};
export function compileDiagram(args) {
  if (!Array.isArray(args.nodes) || args.nodes.length<2 || args.nodes.length>5 || !Array.isArray(args.links) || args.links.length>6) throw Error('Use 2–5 short labelled nodes and at most 6 links.');
  const ids=new Set(args.nodes.map(n=>n.id));
  if(ids.size!==args.nodes.length || args.nodes.some(n=>! /^[a-zA-Z0-9_-]{1,40}$/.test(n.id) || typeof n.label!=='string' || !n.label.trim() || n.label.length>60)) throw Error('Use unique node IDs and labels of 1–60 characters.');
  const common={text:'',color:'ink',points:[],fromID:'',toID:''};
  const elements=args.nodes.map((n,i)=>({...common,id:n.id,kind:'rectangle',x:300,y:60+i*175,width:400,height:100,text:n.label}));
  args.links.forEach((link,i)=>{
    if(!ids.has(link.fromID)||!ids.has(link.toID)||link.fromID===link.toID) throw Error('Each link needs two different IDs from nodes.');
    let id=`link_${i}`;while(ids.has(id))id='_'+id;ids.add(id);
    elements.push({...common,id,kind:'arrow',x:0,y:0,width:0,height:0,...link});
  });
  return {expectedRevision:args.expectedRevision,title:args.title,mode:args.mode,removeIDs:[],elements};
}
