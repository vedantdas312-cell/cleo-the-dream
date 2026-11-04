import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
await mkdir('.local',{recursive:true,mode:0o700});
const path='.local/cleo-local.env';
let env;
try { env=parseEnv(await readFile(path,'utf8')); }
catch(error) {
  if(error.code!=='ENOENT') throw error;
  env={KEIKI_WEBHOOK_KEY:randomBytes(32).toString('hex'),DOWNLOAD_SIGNING_SECRET:randomBytes(32).toString('hex'),
    CLEO_DESKTOP_SENDER:'local-tester',KEIKI_ATTACHMENT_ORIGINS:'https://media.example',PUBLIC_URL:'http://127.0.0.1:3000',PORT:'3000',
    CLEO_LOCAL_DB:resolve('.local/cleo-files.sqlite'),CLEO_CONTEXT_DB:resolve('.local/cleo-context.sqlite')};
  await writeFile(path,Object.entries(env).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n')+'\n',{mode:0o600,flag:'wx'});
}
const sender=env.CLEO_DESKTOP_SENDER??'local-tester';
env.CLEO_DESKTOP_SENDER=sender;
if (!env.CLEO_DESKTOP_TOKEN) {
 env.CLEO_DESKTOP_TOKEN=randomBytes(32).toString('hex');
 env.CLEO_DESKTOP_SENDER=sender;
 await writeFile(path,Object.entries(env).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n')+'\n',{mode:0o600});
}
const owner=createHmac('sha256',env.DOWNLOAD_SIGNING_SECRET).update(sender).digest('hex');
await writeFile('.local/context.env',`CLEO_CONTEXT_URL=${env.PUBLIC_URL}\nCLEO_DESKTOP_TOKEN=${env.CLEO_DESKTOP_TOKEN}\nCLEO_CONTEXT_OWNER=${owner}\nCLEO_CONTEXT_DB=${JSON.stringify(env.CLEO_CONTEXT_DB)}\n`,{mode:0o600});
console.log('Local backend and desktop context paired. Local fixture identity is separate from the hosted iMessage account; no hosted configuration changed.');
