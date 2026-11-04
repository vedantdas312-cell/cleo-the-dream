import PDFDocument from 'pdfkit';
import JSZip from 'jszip';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { fileURLToPath } from 'node:url';
import { DocumentError } from './docx.ts';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const elements = (e: Element, tag: string) => Array.from(e.getElementsByTagNameNS(W, tag));
const parse = (s: string) => new DOMParser({ onError: () => { throw new DocumentError('Cannot read the redline preview.'); } }).parseFromString(s, 'application/xml');
type Span = { text: string; kind: 'normal' | 'insert' | 'delete' };

// A deliberately separate, text-only comparison. It never executes or renders source objects.
// Markup is drawn as PDF text/lines, so phone viewers cannot silently switch it off.
export async function createReviewPdf(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  const source = parse(await zip.file('word/document.xml')!.async('string'));
  const commentPart = zip.file('word/comments.xml');
  const comments = commentPart ? parse(await commentPart.async('string')) : undefined;
  const notes = new Map(comments ? Array.from(comments.getElementsByTagNameNS(W, 'comment')).map(c => [c.getAttributeNS(W, 'id'), elements(c, 't').map(t => t.textContent).join('')]) : []);
  const pdf = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, info: { Title: 'Contract redline review', Author: 'Cleo' } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => { pdf.on('data', c => chunks.push(c)); pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject); });
  pdf.registerFont('Body', fileURLToPath(new URL('./assets/fonts/DejaVuSans.ttf', import.meta.url)));
  pdf.registerFont('Heading', fileURLToPath(new URL('./assets/fonts/DejaVuSans-Bold.ttf', import.meta.url)));
  pdf.font('Heading').fontSize(18).text('Contract redline review');
  pdf.moveDown(0.5).font('Body').fontSize(9).fillColor('#444444')
    .text('Text comparison for review. Red strikethrough = deletion. Blue underline = insertion. Unchanged wording is black. Use the accompanying Word file to accept or reject edits. Original layout and visual content are not reproduced.');
  pdf.moveDown(1);
  let noteNumber = 0;
  for (const p of Array.from(source.getElementsByTagNameNS(W, 'p'))) {
    const spans: Span[] = [];
    const walk = (e: Element, kind: Span['kind'] = 'normal') => {
      if (e.namespaceURI !== W) return;
      if (e.localName === 'ins') kind = 'insert';
      if (e.localName === 'del') kind = 'delete';
      if (e.localName === 'br') { spans.push({text: '\n', kind}); return; }
      if (e.localName === 't' || e.localName === 'delText') { spans.push({ text: e.textContent ?? '', kind }); return; }
      // Nested table paragraphs are handled independently by the outer loop.
      for (const child of Array.from(e.childNodes)) if (child.nodeType === 1 && (child as Element).localName !== 'p') walk(child as Element, kind);
    };
    walk(p);
    if (!spans.some(s => s.text)) continue;
    const style = elements(p, 'pStyle')[0]?.getAttributeNS(W, 'val') ?? '';
    const heading = /^(Title|Heading)/i.test(style);
    if (pdf.y > pdf.page.height - 120) pdf.addPage();
    pdf.font(heading ? 'Heading' : 'Body').fontSize(heading ? 12 : 10);
    // A standalone newline in a continued PDFKit text run is treated as spacing.
    // End the line explicitly so Word's tracked breaks stay visible in the PDF.
    const lines: Span[][] = [[]];
    for (const span of spans) {
      span.text.split('\n').forEach((text,index) => {
        if(index) lines.push([]);
        if(text) lines.at(-1)!.push({...span,text});
      });
    }
    for (const line of lines) {
      if(!line.length) { pdf.moveDown(0.5); continue; }
      for (let i = 0; i < line.length; i++) {
        const span=line[i];
        pdf.fillColor(span.kind === 'delete' ? '#AA1E25' : span.kind === 'insert' ? '#174FA3' : '#111111')
          .text(span.text, { continued: i < line.length - 1, strike: span.kind === 'delete', underline: span.kind === 'insert', lineGap: 3 });
      }
    }
    pdf.moveDown(0.65);
    const ids = elements(p, 'commentReference').map(r => r.getAttributeNS(W, 'id'));
    for (const id of ids) {
      const note = notes.get(id); if (!note) continue;
      pdf.font('Body').fontSize(9).fillColor('#444444').text(`Review note ${++noteNumber}: ${note}`, { lineGap: 2, underline: false, strike: false });
      pdf.moveDown(0.8);
    }
  }
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    pdf.font('Body').fontSize(8).fillColor('#666666').text(`Cleo • Proposed changes • ${i + 1} / ${range.count}`, 50, pdf.page.height - 32, { lineBreak: false, underline: false, strike: false });
  }
  pdf.end();
  return done;
}
