import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { GoogleDocs } from '../src/google-docs.mjs';

try {
  const { values } = parseArgs({ options: {
    preview: { type: 'string' }, approve: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: npm run docs:apply -- --preview FILE --approve REVIEWED_SHA256');
    console.log('Creates real Google Docs suggestions. Requires GOOGLE_ACCESS_TOKEN in the environment.');
  } else {
    if (!values.preview || !values.approve) throw new Error('Provide a reviewed preview and its approval digest. Use --help.');
    const plan = JSON.parse(await readFile(values.preview, 'utf8'));
    const docs = new GoogleDocs({ accessToken: process.env.GOOGLE_ACCESS_TOKEN });
    console.log(JSON.stringify(await docs.apply(plan, values.approve), null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
