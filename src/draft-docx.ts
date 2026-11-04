import JSZip from 'jszip';
import { DocumentError, inspectDocx, sha256 } from './docx.ts';

export type DraftInput = { title: string; blocks: { kind: 'heading' | 'paragraph'; text: string }[] };
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

export function validateDraft(value: unknown): DraftInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DocumentError('Provide a draft title and blocks.');
  const input = value as Record<string, unknown>;
  const valid = (s: unknown, max: number): s is string => typeof s === 'string' && !!s.trim() && s.length <= max
    && !/[\u0000-\u001f\ufffe\uffff]/u.test(s) && s.isWellFormed();
  if (Object.keys(input).some(k => !['title', 'blocks'].includes(k)) || !valid(input.title, 160)
    || !Array.isArray(input.blocks) || !input.blocks.length || input.blocks.length > 500) {
    throw new DocumentError('Use a title of up to 160 characters and 1–500 heading or paragraph blocks.');
  }
  const blocks = input.blocks.map(b => {
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => !['kind', 'text'].includes(k))
      || !['heading', 'paragraph'].includes(b.kind) || !valid(b.text, b.kind === 'heading' ? 200 : 8000)) {
      throw new DocumentError('Each block needs a heading or paragraph kind and valid single-line text.');
    }
    return { kind: b.kind as 'heading' | 'paragraph', text: b.text as string };
  });
  if (!blocks.some(b => b.kind === 'paragraph') || blocks.reduce((n, b) => n + b.text.length, 0) > 100_000) {
    throw new DocumentError('Provide substantive paragraphs and at most 100,000 characters.');
  }
  return { title: input.title, blocks };
}

// This renderer packages model-supplied draft text; it does not verify law or invent clauses.
export async function createDraftDocx(value: unknown) {
  const input = validateDraft(value), zip = new JSZip();
  const paragraphs = [{ style: 'Title', text: input.title }, { style: 'DraftLabel', text: 'DRAFT FOR REVIEW' },
    ...input.blocks.map(b => ({ style: b.kind === 'heading' ? 'Heading1' : 'Normal', text: b.text }))];
  const content = paragraphs.map(p => `<w:p><w:pPr><w:pStyle w:val="${p.style}"/></w:pPr><w:r><w:t xml:space="preserve">${xml(p.text)}</w:t></w:r></w:p>`).join('');
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${R}"><Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${R}"><Relationship Id="rId1" Type="${OFFICE}/styles" Target="styles.xml"/></Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${content}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${W}">
    <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:color w:val="000000"/><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/><w:widowControl/></w:pPr></w:pPrDefault></w:docDefaults>
    <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
    <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:after="160"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="DraftLabel"><w:name w:val="Draft Label"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:after="240"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="0"/><w:spacing w:before="200" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
  </w:styles>`);
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const actual = (await inspectDocx(bytes)).paragraphs.map(p => p.text);
  if (JSON.stringify(actual) !== JSON.stringify(paragraphs.map(p => p.text))) throw new Error('Generated draft text did not round-trip.');
  return { bytes, input, outputSha256: sha256(bytes) };
}
