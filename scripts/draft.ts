import { readFile, writeFile } from 'node:fs/promises';
import { createDraftDocx } from '../src/draft-docx.ts';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath || !outputPath.endsWith('.docx')) throw new Error('Usage: node scripts/draft.ts draft.json output.docx');
const result = await createDraftDocx(JSON.parse(await readFile(inputPath, 'utf8')));
await writeFile(outputPath, result.bytes, { flag: 'wx' });
console.log(JSON.stringify({ status: 'generated_draft', path: outputPath, sha256: result.outputSha256, legalAccuracy: 'not_verified', visualLayout: 'not_reviewed' }));
