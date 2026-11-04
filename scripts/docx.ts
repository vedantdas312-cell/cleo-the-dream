import { readFile, writeFile } from 'node:fs/promises';
import { inspectDocx, redlineDocx, DocumentError } from '../src/docx.ts';

const [operation, sourcePath, planPath, outputPath] = process.argv.slice(2);
try {
  if (!sourcePath || !['inspect', 'redline'].includes(operation)) throw new DocumentError('Usage: docx.ts inspect input.docx | redline input.docx plan.json output.docx');
  const input = await readFile(sourcePath);
  if (operation === 'inspect') console.log(JSON.stringify(await inspectDocx(input), null, 2));
  else {
    if (!planPath || !outputPath) throw new DocumentError('Provide plan.json and a new output.docx path.');
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    const result = await redlineDocx(input, plan);
    await writeFile(outputPath, result.bytes, { flag: 'wx' });
    console.log(JSON.stringify({ outputPath, outputSha256: result.outputSha256, revisionCount: result.revisionCount, delivered: false }));
  }
} catch (error) {
  console.error(error instanceof DocumentError ? error.message : 'Document operation failed. Check input files and use a new output filename.'); process.exitCode = 1;
}
