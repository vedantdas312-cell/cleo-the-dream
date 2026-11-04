import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { convert } from 'html-to-text';
import { DocumentError, inspectDocx, MAX_FILE_BYTES, sha256, boundedEntry } from './docx.ts';
import { createDraftDocx } from './draft-docx.ts';

export const SUPPORTED_EXTENSIONS = ['.docx', '.doc', '.pdf', '.html', '.htm', '.pptx', '.ppt', '.txt', '.md'];
export type ImportMetadata = { format: string; originalSha256: string; converted: boolean; warnings: string[];
  omittedSourceFurniture?: {coverSheets:number;pageLabels:number} };

export function pdfReviewText(extracted: string) {
  const pages=extracted.replace(/\f[ \t\r\n]*$/, '').split('\f');
  if(pages.some(p=>!p.trim())) throw new DocumentError('The PDF includes pages with no extractable text. Scanned or image-only pages need OCR or a text/Word version.');
  let coverSheets=0,pageLabels=0;
  const content=pages.flatMap((page,index)=>{
    // Explicitly labelled navigation wrapper, not an inferred contract preamble.
    const compact=page.replace(/\s+/g,' ');
    if(index===0 && /Annexure [A-Z]-\d+/.test(compact)
      && compact.includes('This cover sheet and page labels were added for navigation.')
      && compact.includes('Original source files are preserved separately.')) {coverSheets++;return [];}
    const lines=page.split('\n');const nonempty=lines.flatMap((line,i)=>line.trim()?[i]:[]);
    return [lines.filter((line,i)=>{
      const edge=nonempty.indexOf(i);if(edge<0 || (edge>2 && edge<nonempty.length-3))return true;
      const furniture=/^(?:Docusign Envelope ID:\s*[A-Fa-f0-9-]{32,36}|Annexure [A-Z]-\d+\s*\|\s*Page \d+\s*\|\s*Source page \d+|Page \d+(?: of \d+)?)$/i.test(line.trim());
      if(furniture)pageLabels++;
      return !furniture;
    }).join('\n').trim()];
  });
  return {text:content.filter(Boolean).join('\n\n'),omittedSourceFurniture:{coverSheets,pageLabels}};
}
// Respect visible line boundaries for clause numbers, headings and checklist entries.
// Do not infer legal structure by splitting sentences or embedded cross-references.
export function structuredTextBlocks(text: string): { kind: 'heading' | 'paragraph'; text: string }[] {
  const blocks: { kind: 'heading' | 'paragraph'; text: string }[] = [];
  let pending: string[] = [];
  const flush = () => { if (pending.length) blocks.push({ kind: 'paragraph', text: pending.join(' ') }); pending = []; };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\t/g, ' ').trim();
    if (!line) { flush(); continue; }
    const numbered = /^\d{1,2}(?:\.\d{1,2})*\.?\s+[A-Z]/.test(line);
    const upper = line.length <= 160 && /[A-Z]{3}/.test(line) && !/[a-z]/.test(line) && !/[.;]$/.test(line);
    const heading = upper || (/^(?:SCHEDULE|EXHIBIT|APPENDIX)\s+[A-Z0-9]/.test(line) && line.length <= 160)
      || (numbered && line.length <= 100 && !/[.;:]$/.test(line));
    if (heading) { flush(); blocks.push({ kind: 'heading', text: line }); }
    else { if (numbered || /^[☐☑□•]\s/.test(line)) flush(); pending.push(line); }
  }
  flush();
  // Only whitespace may change during structure recovery.
  if (blocks.map(b => b.text).join(' ').replace(/\s+/g, ' ').trim() !== text.replace(/\s+/g, ' ').trim())
    throw new DocumentError('Structure recovery changed the extracted wording.');
  return blocks;
}
const run = promisify(execFile);
const MAX_TEXT = 95_000;
function parseXml(text: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new DocumentError('Document XML contains unsupported entity declarations.');
  try { return new DOMParser({ onError: () => { throw Error(); } }).parseFromString(text, 'application/xml'); }
  catch { throw new DocumentError('Document XML is invalid.'); }
}
async function pptxText(bytes: Buffer) {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch { throw new DocumentError('PowerPoint file is invalid or encrypted.'); }
  const entries = Object.values(zip.files);
  if (entries.length > 2000) throw new DocumentError('PowerPoint has too many parts.');
  const parts = new Map<string, string>(); let total = 0;
  for (const e of entries) {
    if (e.dir) continue;
    if (/vbaProject|_xmlsignatures/i.test(e.name)) throw new DocumentError('Macro-enabled or digitally signed PowerPoint files are unsupported.');
    const data = await boundedEntry(e, Math.min(10 * 1024 * 1024, 40 * 1024 * 1024 - total)); total += data.length;
    if (e.name.endsWith('.xml') || e.name.endsWith('.rels')) parts.set(e.name, data.toString('utf8'));
  }
  const p = parts.get('ppt/presentation.xml'), rel = parts.get('ppt/_rels/presentation.xml.rels');
  if (!p || !rel) throw new DocumentError('PowerPoint presentation structure is missing.');
  const relationships = Array.from(parseXml(rel).getElementsByTagName('Relationship'));
  const ids = Array.from(parseXml(p).getElementsByTagNameNS('http://schemas.openxmlformats.org/presentationml/2006/main', 'sldId'));
  if (!ids.length || ids.length > 200) throw new DocumentError('Use a PowerPoint with 1–200 slides.');
  return ids.map((id, i) => {
    const rid = id.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const r = relationships.find(r => r.getAttribute('Id') === rid);
    const target = r?.getAttribute('Target') ?? '';
    if (r?.getAttribute('TargetMode') === 'External' || !/^slides\/slide\d+\.xml$/.test(target)) throw new DocumentError('Unsupported PowerPoint slide relationship.');
    const slide = parts.get('ppt/' + target); if (!slide) throw new DocumentError('PowerPoint slide is missing.');
    const ns = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const text = Array.from(parseXml(slide).getElementsByTagNameNS(ns, 'p')).map(p => Array.from(p.getElementsByTagNameNS(ns, 't')).map(t => t.textContent ?? '').join('')).filter(s => s.trim()).join('\n\n');
    if (!text.trim()) throw new DocumentError(`Slide ${i + 1} has no extractable text. Supply a text version or remove image-only slides from the review copy.`);
    return `Slide ${i + 1}\n\n${text}`;
  }).join('\n\n');
}
async function nativeText(bytes: Buffer, ext: string) {
  const dir = await mkdtemp(join(tmpdir(), 'cleo-import-'));
  try {
    const path = join(dir, 'input' + ext); await writeFile(path, bytes, { mode: 0o600 });
    const command = ext === '.pdf' ? 'pdftotext' : ext === '.doc' ? 'antiword' : 'catppt';
    const args = ext === '.pdf' ? ['-layout', '-enc', 'UTF-8', path, '-'] : ext === '.doc' ? ['-m', 'UTF-8.txt', path] : ['-d', 'utf-8', path];
    // Parsers receive only a private temporary file. No shell, macros, URL fetching or app credentials.
    const { stdout } = await run(command, args, { timeout: 20_000, maxBuffer: 512_000, encoding: 'utf8', env: { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: dir }, killSignal: 'SIGKILL' });
    if (ext === '.pdf') {
      return pdfReviewText(stdout);
    }
    return {text:stdout.replace(/\f/g, '\n\n')};
  } catch (e) {
    if (e instanceof DocumentError) throw e;
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new DocumentError('This format converter is unavailable on the server. Try a DOCX or plain-text copy.');
    throw new DocumentError('The file could not be safely converted within the limits. It may be encrypted, damaged or too complex. Try a clean DOCX or text export.');
  } finally { await rm(dir, { recursive: true, force: true }); }
}
export async function importDocument(bytes: Buffer, filename: string) {
  if (bytes.length > MAX_FILE_BYTES) throw new DocumentError('Documents must be at most 10 MB.');
  const ext = extname(filename).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) throw new DocumentError('Supported files: DOCX, DOC, PDF, HTML, HTM, PPTX, PPT, TXT and MD.');
  const metadata: ImportMetadata = { format: ext.slice(1), originalSha256: sha256(bytes), converted: ext !== '.docx', warnings: [] };
  if (ext === '.docx') { await inspectDocx(bytes); return { bytes, metadata }; }
  let text: string;
  if (ext === '.pptx') text = await pptxText(bytes);
  else if (['.pdf', '.doc', '.ppt'].includes(ext)) {
    const validMagic = ext === '.pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : bytes.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1';
    if (!validMagic) throw new DocumentError('File content does not match its extension. Export a clean copy in the correct format.');
    const extracted=await nativeText(bytes, ext);text=extracted.text;
    if ('omittedSourceFurniture' in extracted) metadata.omittedSourceFurniture=extracted.omittedSourceFurniture;
  } else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new DocumentError('Text and HTML files must use UTF-8 encoding.'); }
    if (ext === '.html' || ext === '.htm') {
      const marker = 'CLEO_HTML_EXTRACTION_LIMIT_REACHED';
      text = convert(text, { wordwrap: false, limits: { maxInputLength: MAX_FILE_BYTES, maxDepth: 100, maxChildNodes: 50_000, ellipsis: marker }, selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }, { selector: 'script', format: 'skip' }, { selector: 'style', format: 'skip' }, { selector: 'h1', options: { uppercase: false } }, { selector: 'h2', options: { uppercase: false } }, { selector: 'h3', options: { uppercase: false } }] });
      if (text.includes(marker)) throw new DocumentError('HTML is too complex to extract completely. Supply a simpler export.');
    }
  }
  if (!text.trim()) throw new DocumentError('No readable text was extracted. Scanned files need OCR or a text/Word copy.');
  if (text.length > MAX_TEXT) throw new DocumentError('Converted text exceeds 95,000 characters. Split the document into labelled sections.');
  if (/[\u0000-\u0008\u000b\u000e-\u001f\ufffe\uffff]/u.test(text)) throw new DocumentError('Extracted text contains unsupported control characters. Supply a clean text export.');
  const blocks = structuredTextBlocks(text);
  if (blocks.length > 490 || blocks.some(p => p.text.length > 8000)) throw new DocumentError('Converted content exceeds paragraph limits. Split the source into smaller sections.');
  metadata.warnings = ['Converted text-only review copy. Original layout, formatting, images, signatures and embedded objects are not preserved. Tracked changes compare against extracted text, not the original file. Extraction can miss visual content; compare this copy with the original before relying on it.'];
  if(metadata.omittedSourceFurniture && (metadata.omittedSourceFurniture.coverSheets || metadata.omittedSourceFurniture.pageLabels))
    metadata.warnings.push('Navigation cover sheets and identified page-header/footer labels are omitted from this review body; the original PDF is retained.');
  if (ext === '.pptx' || ext === '.ppt') metadata.warnings.push('Slide text only; speaker notes, charts, SmartArt and image text are outside review coverage.');
  const draft = await createDraftDocx({ title: 'Contract review copy', blocks: [{ kind: 'paragraph', text: metadata.warnings.join(' ') }, ...blocks] });
  return { bytes: draft.bytes, metadata };
}
