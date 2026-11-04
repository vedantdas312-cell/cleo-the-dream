import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('a sketch completes when WebKit stops delivering animation frames', async () => {
  class Element {
    children = []; attrs = {}; style = {};
    constructor(tag) { this.tag = tag; }
    setAttribute(key, value) { this.attrs[key] = value; }
    getAttribute(key) { return this.attrs[key]; }
    append(...nodes) { this.children.push(...nodes); }
    prepend(node) { this.children.unshift(node); }
    replaceChildren(...nodes) { this.children = nodes; }
    querySelectorAll(tag) { return this.children.filter(node => node.tag === tag); }
    querySelector(tag) { return this.querySelectorAll(tag)[0]; }
    getBBox() { return {x: 0, y: 0, width: 100, height: 40}; }
    remove() {}
  }
  const nodes = new Map(), timers = new Map(); let now = 0, serial = 0;
  const context = vm.createContext({ structuredClone, window: {},
    document: { createElementNS: (_, tag) => new Element(tag), querySelector: id => {
      if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id);
    } },
    matchMedia: () => ({matches: false}), performance: {now: () => now},
    requestAnimationFrame: () => ++serial, cancelAnimationFrame: () => {},
    setTimeout: callback => { const id = ++serial; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(await readFile(new URL('../desktop/NotepadWeb/renderer.js', import.meta.url), 'utf8'), context);
  const sketch = context.window.cleoSketch;
  const item = {id: 'notice', kind: 'label', x: 60, y: 80, width: 300, height: 100,
    text: 'Thirty days', color: 'ink', points: []};
  assert.equal(sketch.stage({epoch: 1, patch: {expectedRevision: 0, title: 'Notice',
    mode: 'replace', removeIDs: [], elements: [item]}}).ok, true);
  sketch.begin({epoch: 1});
  for (let tick = 0; tick < 20 && sketch.read().status === 'drawing'; tick++) {
    now += 100;
    for (const callback of [...timers.values()]) callback();
    await Promise.resolve();
  }
  assert.equal(sketch.read().status, 'idle');
  assert.equal(sketch.read().elements[0].id, 'notice');
  assert.equal(timers.size, 0);
});
