import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Keiki, conversationId } from '../src/keiki.mjs';

try {
  const { values } = parseArgs({ options: {
    user: { type: 'string' }, matter: { type: 'string' }, session: { type: 'string' },
    input: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: npm run athena:ask -- --user ID --matter ID --session ID --input FILE [--dry-run]');
  } else {
    const scope = { userId: values.user, matterId: values.matter, sessionId: values.session, audience: 'private' };
    const id = conversationId(scope);
    if (!values.input) throw new Error('Provide a message file with --input. Use --help.');
    const text = await readFile(values.input, 'utf8');
    if (!text.trim() || text.length > 20_000) throw new Error('Message must contain 1–20,000 characters.');
    if (values['dry-run']) {
      console.log(JSON.stringify({ mode: 'OFFLINE — no Keiki call made', conversationId: id, audience: scope.audience, messageCharacters: text.length, tools: 'disabled' }, null, 2));
    } else {
      const api = new Keiki({ apiKey: process.env.KEIKI_API_KEY, agentId: process.env.KEIKI_AGENT_ID, baseUrl: process.env.KEIKI_BASE_URL });
      const reply = await api.ask({ text, scope });
      console.log(reply.text);
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
