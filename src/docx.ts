import JSZip from 'jszip';
import { diffWordsWithSpace } from 'diff';
import { DOMParser, XMLSerializer, type Element, type Document } from '@xmldom/xmldom';
import { createHash } from 'node:crypto';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML = 'http://www.w3.org/XML/1998/namespace';
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 40 * 1024 * 1024;
const children = (element: Element) => Array.from(element.childNodes).filter(n => n.nodeType === 1) as Element[];
const is = (element: Element, name: string) => element.namespaceURI === W && element.localName === name;
const elements = (document: Document | Element, name: string) => Array.from(document.getElementsByTagNameNS(W, name));
const textOf = (node: Element) => Array.from(node.getElementsByTagNameNS(W, '*'))
  .map(e => is(e, 't') ? e.textContent ?? '' : is(e, 'br') ? '\n' : '').join('');
export const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

export class DocumentError extends Error {}
function xml(value: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new DocumentError('DTD and entity declarations are not supported.');
  try { return new DOMParser({ onError: () => { throw new Error('Invalid XML'); } }).parseFromString(value, 'application/xml'); }
  catch { throw new DocumentError('The Word file contains invalid XML.'); }
}

export async function boundedEntry(file: JSZip.JSZipObject, budget: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const stream = file.nodeStream('nodebuffer');
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > budget) { stream.pause(); reject(new DocumentError('Expanded document exceeds the size limit.')); return; }
      chunks.push(chunk);
    });
    stream.on('error', () => reject(new DocumentError('Cannot decompress this Word file.')));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function openDocx(input: Buffer) {
  if (input.length > MAX_FILE_BYTES) throw new DocumentError('Word files must be at most 10 MB.');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(input); } catch { throw new DocumentError('Send a valid .docx Word file, not a PDF, .doc or encrypted document.'); }
  const entries = Object.values(zip.files);
  if (entries.length > 1000) throw new DocumentError('Too many parts in this Word file.');
  let expanded = 0; const parts = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.dir) continue;
    if (/vbaProject|_xmlsignatures/i.test(entry.name)) throw new DocumentError('Macro-enabled or digitally signed documents are not supported.');
    const bytes = await boundedEntry(entry, Math.min(10 * 1024 * 1024, MAX_EXPANDED_BYTES - expanded));
    expanded += bytes.length; parts.set(entry.name, bytes);
  }
  const source = parts.get('word/document.xml');
  const types = parts.get('[Content_Types].xml');
  if (!source || !types || !types.toString().includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')) {
    throw new DocumentError('This is not a supported .docx document.');
  }
  for (const [name, bytes] of parts) {
    if (!name.startsWith('word/') || !name.endsWith('.xml')) continue;
    const parsed = xml(bytes.toString());
    if (Array.from(parsed.getElementsByTagNameNS(W, '*')).some(e => /^(ins|del|moveFrom|moveTo|.*Change|.*RangeStart|.*RangeEnd)$/.test(e.localName ?? '') && !/^(bookmark|comment)/.test(e.localName ?? ''))) {
      throw new DocumentError('Existing revisions are present. Send a clean copy; Cleo will not accept or overwrite someone else’s changes.');
    }
  }
  const document = xml(source.toString());
  if (document.documentElement?.namespaceURI !== W) throw new DocumentError('Only standard transitional Word documents are supported.');
  const paragraphs = elements(document, 'p');
  return { zip, parts, document, paragraphs };
}

function editable(p: Element) {
  return children(p).every(c => is(c, 'pPr') || (is(c, 'r') && children(c).every(r => is(r, 'rPr') || is(r, 't'))));
}

export async function inspectDocx(input: Buffer) {
  const { paragraphs, parts } = await openDocx(input);
  return { sourceSha256: sha256(input),
    coverage: { scope: 'Main document body and table paragraphs only. Headers, footers, footnotes, endnotes, comments, images and embedded documents are not reviewed.',
      unreviewedParts: [...parts.keys()].filter(name => /^word\/(header|footer|footnotes|endnotes|comments|embeddings)/.test(name)) },
    paragraphs: paragraphs.map((p, index) => ({ id: `p${index}`, text: textOf(p), editable: editable(p),
      style: elements(p, 'pStyle')[0]?.getAttributeNS(W, 'val') ?? 'Normal' })) };
}

export type Replacement = { paragraphId: string; original: string; replacement: string; reason: string };
export type RedlinePlan = { sourceSha256: string; changes: Replacement[] };

function runFragment(document: Document, run: Element, value: string, deletion = false) {
  const copy = run.cloneNode(false) as Element;
  for (const prop of children(run).filter(c => is(c, 'rPr'))) copy.appendChild(prop.cloneNode(true));
  value.split('\n').forEach((line, index) => {
    if (index) copy.appendChild(document.createElementNS(W, 'w:br'));
    const t = document.createElementNS(W, deletion ? 'w:delText' : 'w:t');
    t.setAttributeNS(XML, 'xml:space', 'preserve'); t.appendChild(document.createTextNode(line)); copy.appendChild(t);
  });
  return copy;
}

// Preserve every unchanged word, including short legally meaningful terms (not, or, shall).
export function readableDiff(original: string, replacement: string) {
  const raw = diffWordsWithSpace(original, replacement, { timeout: 1000, maxEditLength: 4000 });
  if (!raw) return undefined;
  const result: { value: string; added?: boolean; removed?: boolean }[] = [];
  let deleted = '', inserted = '';
  const flush = () => {
    if (deleted) result.push({ value: deleted, removed: true });
    if (inserted) result.push({ value: inserted, added: true });
    deleted = ''; inserted = '';
  };
  raw.forEach((part, i) => {
    const tinyIsland = !part.added && !part.removed && i > 0 && i < raw.length - 1
      && /^\s+$/.test(part.value);
    if (part.removed || tinyIsland) deleted += part.value;
    if (part.added || tinyIsland) inserted += part.value;
    if (!part.added && !part.removed && !tinyIsland) { flush(); result.push({ value: part.value }); }
  });
  flush(); return result;
}

export async function redlineDocx(input: Buffer, plan: RedlinePlan, now = new Date()) {
  if (plan?.sourceSha256 !== sha256(input)) throw new DocumentError('The source document changed. Read it again before proposing edits.');
  if (!Array.isArray(plan.changes) || !plan.changes.length || plan.changes.length > 50) throw new DocumentError('Provide between 1 and 50 exact replacements.');
  const { zip, parts, document, paragraphs } = await openDocx(input);
  const originalTexts = paragraphs.map(textOf);
  const seen = new Set<string>();
  // One replacement per paragraph avoids dependent/overlapping edits in this first slice.
  for (const change of plan.changes) {
    if (!change || typeof change.paragraphId !== 'string' || !/^p\d+$/.test(change.paragraphId) || seen.has(change.paragraphId)) throw new DocumentError('Use one replacement per paragraph.');
    seen.add(change.paragraphId);
    const p = paragraphs[Number(change.paragraphId.slice(1))];
    if (!p || !editable(p)) throw new DocumentError('The selected paragraph has unsupported fields, links or embedded content.');
    for (const [field, value] of Object.entries({original: change.original, replacement: change.replacement, reason: change.reason})) {
      const invalid = field === 'replacement' ? /[\u0000-\u0009\u000b-\u001f\ufffe\uffff]/u : /[\u0000-\u001f\ufffe\uffff]/u;
      if (typeof value !== 'string' || value.length > 20_000 || invalid.test(value) || !value.isWellFormed()) throw new DocumentError('Use valid text. Only replacement may contain newline separators; keep original and reason single-line.');
    }
    if (change.replacement.split('\n').length > 40) throw new DocumentError('Use at most 40 clause lines in one replacement.');
    const sections = change.replacement.match(/\b[A-Z]\.\d+\s+[A-Z]/g) ?? [];
    if (sections.length >= 3 && !change.replacement.includes('\n')) throw new DocumentError('Separate new numbered sections with newline characters. Do not flatten an exhibit into one paragraph.');
    if (!change.original || !change.reason.trim() || change.original === change.replacement) throw new DocumentError('Each change needs distinct wording and a reason.');
    const text = textOf(p), start = text.indexOf(change.original);
    if (start < 0 || text.indexOf(change.original, start + 1) >= 0) throw new DocumentError('Original wording must match exactly once in its paragraph.');
  }
  const packageNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const officeNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const typeNs = 'http://schemas.openxmlformats.org/package/2006/content-types';
  const rels = xml(parts.get('word/_rels/document.xml.rels')?.toString() ?? `<Relationships xmlns="${packageNs}"/>`);
  const types = xml(parts.get('[Content_Types].xml')!.toString());
  function wire(name: string, contentType: string) {
    const type = `${officeNs}/${name}`;
    const existing = Array.from(rels.getElementsByTagNameNS(packageNs, 'Relationship')).find(r => r.getAttribute('Type') === type);
    if (existing && (existing.getAttribute('Target') !== `${name}.xml` || existing.getAttribute('TargetMode') === 'External'))
      throw new DocumentError('This document uses a nonstandard review-part location. Supply a standard Word copy.');
    if (!existing) {
      const ids = new Set(Array.from(rels.getElementsByTagNameNS(packageNs, 'Relationship')).map(r => r.getAttribute('Id')));
      let id = 1; while (ids.has(`rIdCleo${id}`)) id++;
      const r = rels.createElementNS(packageNs, 'Relationship');
      r.setAttribute('Id', `rIdCleo${id}`); r.setAttribute('Type', type); r.setAttribute('Target', `${name}.xml`); rels.documentElement!.appendChild(r);
    }
    if (!Array.from(types.getElementsByTagNameNS(typeNs, 'Override')).some(t => t.getAttribute('PartName') === `/word/${name}.xml`)) {
      const t = types.createElementNS(typeNs, 'Override'); t.setAttribute('PartName', `/word/${name}.xml`); t.setAttribute('ContentType', contentType); types.documentElement!.appendChild(t);
    }
  }
  wire('comments', 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml');
  wire('settings', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml');
  const comments = xml(parts.get('word/comments.xml')?.toString() ?? `<w:comments xmlns:w="${W}"/>`);
  const settings = xml(parts.get('word/settings.xml')?.toString() ?? `<w:settings xmlns:w="${W}"/>`);
  for (const name of ['revisionView', 'trackRevisions']) {
    let node = elements(settings, name)[0];
    if (!node) { node = settings.createElementNS(W, `w:${name}`); settings.documentElement!.appendChild(node); }
    if (name === 'revisionView') for (const key of ['markup', 'comments', 'insDel']) node.setAttributeNS(W, `w:${key}`, '1');
    else node.setAttributeNS(W, 'w:val', '1');
  }
  let revision = Array.from(document.getElementsByTagNameNS(W, '*')).reduce((max, e) => Math.max(max, Number(e.getAttributeNS(W, 'id')) || 0), 0);
  let commentId = Math.max(-1, ...elements(comments, 'comment').map(e => Number(e.getAttributeNS(W, 'id')) || 0),
    ...elements(document, 'commentReference').map(e => Number(e.getAttributeNS(W, 'id')) || 0));
  let revisionCount = 0;
  for (const change of plan.changes) {
    const p = paragraphs[Number(change.paragraphId.slice(1))];
    const original = textOf(p), start = original.indexOf(change.original), end = start + change.original.length;
    const diff = readableDiff(change.original, change.replacement);
    if (!diff || diff.filter(d => d.added || d.removed).length + revisionCount > 2000)
      throw new DocumentError('This edit is too large for a precise redline. Split it into smaller clause edits.');
    if (diff.filter(d => !d.added).map(d => d.value).join('') !== change.original || diff.filter(d => !d.removed).map(d => d.value).join('') !== change.replacement)
      throw new DocumentError('Exact word comparison failed. No redline was produced.');
    let offset = 0;
    const runs = children(p).filter(c => is(c, 'r')).map(run => { const text = textOf(run), from = offset; offset += text.length; return { run, text, from, to: offset }; });
    const output: Element[] = [];
    const slices = (from: number, to: number, deletion = false) => runs.filter(r => r.to > from && r.from < to)
      .map(r => runFragment(document, r.run, r.text.slice(Math.max(0, from - r.from), Math.min(r.text.length, to - r.from)), deletion));
    const wrap = (name: string) => {
      const node = document.createElementNS(W, `w:${name}`);
      node.setAttributeNS(W, 'w:id', String(++revision)); node.setAttributeNS(W, 'w:author', 'Cleo'); node.setAttributeNS(W, 'w:date', now.toISOString());
      revisionCount++; return node;
    };
    const id = String(++commentId);
    const anchor = (name: string) => { const e = document.createElementNS(W, `w:${name}`); e.setAttributeNS(W, 'w:id', id); return e; };
    output.push(...slices(0, start), anchor('commentRangeStart'));
    let cursor = start;
    let replacedFrom: number | undefined;
    for (const part of diff) {
      if (part.added) {
        const node = wrap('ins');
        const styleAt = replacedFrom ?? cursor;
        const style = runs.find(r => r.from <= styleAt && r.to > styleAt) ?? runs.at(-1)!;
        node.appendChild(runFragment(document, style.run, part.value)); output.push(node);
      } else {
        replacedFrom = part.removed ? cursor : undefined;
        const fragments = slices(cursor, cursor + part.value.length, part.removed);
        if (part.removed) { const node = wrap('del'); for (const fragment of fragments) node.appendChild(fragment); output.push(node); }
        else output.push(...fragments);
        cursor += part.value.length;
      }
    }
    output.push(anchor('commentRangeEnd'));
    const ref = document.createElementNS(W, 'w:r'); ref.appendChild(anchor('commentReference')); output.push(ref, ...slices(end, original.length));
    for (const { run } of runs) p.removeChild(run);
    for (const node of output) p.appendChild(node);
    const comment = comments.createElementNS(W, 'w:comment');
    comment.setAttributeNS(W, 'w:id', id); comment.setAttributeNS(W, 'w:author', 'Cleo'); comment.setAttributeNS(W, 'w:initials', 'CL'); comment.setAttributeNS(W, 'w:date', now.toISOString());
    const cp = comments.createElementNS(W, 'w:p'), cr = comments.createElementNS(W, 'w:r'), ct = comments.createElementNS(W, 'w:t');
    ct.setAttributeNS(XML, 'xml:space', 'preserve'); ct.appendChild(comments.createTextNode(change.reason.trim())); cr.appendChild(ct); cp.appendChild(cr); comment.appendChild(cp); comments.documentElement!.appendChild(comment);
  }
  const serialize = (doc: Document) => new XMLSerializer().serializeToString(doc);
  zip.file('word/comments.xml', serialize(comments)); zip.file('word/settings.xml', serialize(settings));
  zip.file('word/_rels/document.xml.rels', serialize(rels)); zip.file('[Content_Types].xml', serialize(types));
  // Real revision elements carry the edits; no reliance on a tracking-mode toggle.
  zip.file('word/document.xml', new XMLSerializer().serializeToString(document));
  const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const check = await JSZip.loadAsync(output);
  const saved = xml(await check.file('word/document.xml')!.async('string'));
  const savedParagraphs = elements(saved, 'p');
  for (let i = 0; i < originalTexts.length; i++) {
    const change = plan.changes.find(c => c.paragraphId === `p${i}`);
    const expected = change ? originalTexts[i].replace(change.original, () => change.replacement) : originalTexts[i];
    if (textOf(savedParagraphs[i]) !== expected) throw new DocumentError('Accepted-text verification failed.');
    const rejected = savedParagraphs[i].cloneNode(true) as Element;
    for (const insertion of elements(rejected, 'ins')) insertion.parentNode!.removeChild(insertion);
    const original = Array.from(rejected.getElementsByTagNameNS(W, '*')).map(e => is(e, 't') || is(e, 'delText') ? e.textContent : is(e, 'br') ? '\n' : '').join('');
    if (original !== originalTexts[i]) throw new DocumentError('Rejecting revisions did not restore the original.');
  }
  return { bytes: output, commentCount: plan.changes.length, sourceSha256: plan.sourceSha256, outputSha256: sha256(output), revisionCount: elements(saved, 'ins').length + elements(saved, 'del').length, changes: plan.changes };
}
