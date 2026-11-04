import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { GoogleDocs } from '../src/google-docs.mjs';
import { approvalDigest, planReplacement } from '../src/docs-plan.mjs';

try {
  const { values } = parseArgs({ options: {
    document: { type: 'string' }, fixture: { type: 'string' }, change: { type: 'string' },
    output: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: npm run docs:preview -- (--document DOC_ID | --fixture FILE) --change FILE [--output FILE]');
  } else {
    if (!values.change || Boolean(values.document) === Boolean(values.fixture)) throw new Error('Choose one document ID or fixture, and a change JSON file. Use --help.');
    const change = JSON.parse(await readFile(values.change, 'utf8'));
    const plan = values.fixture
      ? planReplacement(JSON.parse(await readFile(values.fixture, 'utf8')), change)
      : await new GoogleDocs({ accessToken: process.env.GOOGLE_ACCESS_TOKEN }).preview(values.document, change);
    console.log(values.fixture ? 'OFFLINE FIXTURE — no Google document was read or changed.' : 'LIVE READ — no document changes made.');
    console.log(JSON.stringify({ documentId: plan.documentId, tabId: plan.tabId, original: plan.original, replacement: plan.replacement, revisionId: plan.revisionId, approvalDigest: approvalDigest(plan) }, null, 2));
    if (values.output) {
      await writeFile(values.output, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      console.log(`Preview saved to ${values.output}. Review before applying.`);
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
