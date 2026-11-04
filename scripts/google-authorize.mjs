import { readFile, writeFile, chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
const clientPath = process.env.CLEO_GOOGLE_CLIENT || '.local/google-client.json';
const client = JSON.parse(await readFile(clientPath,'utf8')).installed;
if (!client?.client_id || !client.client_secret) throw new Error('Use a Google Desktop app OAuth client JSON.');
await chmod(clientPath,0o600);
const scopes = ['https://www.googleapis.com/auth/drive.file'];
const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
let redirect, authorization, processing = false;
const server = createServer(async (req,res) => {
  res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','no-referrer');
  const url = new URL(req.url,'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/start') { res.writeHead(302,{Location:authorization}); res.end(); return; }
  const given = Buffer.from(url.searchParams.get('state')??''), expected = Buffer.from(state);
  if (url.pathname !== '/callback' || given.length !== expected.length || !timingSafeEqual(given,expected) || processing) {
    res.writeHead(400); res.end('Invalid authorization response.'); return;
  }
  processing = true;
  try {
    if (url.searchParams.get('error') || !url.searchParams.get('code')) throw new Error('Authorization not granted.');
    const response = await fetch('https://oauth2.googleapis.com/token', {method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
      body:new URLSearchParams({client_id:client.client_id,client_secret:client.client_secret,code:url.searchParams.get('code'),
        redirect_uri:redirect,grant_type:'authorization_code',code_verifier:verifier})});
    if (!response.ok) throw new Error('Token exchange failed.');
    const tokens = await response.json();
    if (!tokens.refresh_token || !scopes.every(scope => tokens.scope?.split(' ').includes(scope))) throw new Error('Required Google access was not granted.');
    await writeFile('.local/google-oauth.json',JSON.stringify({refresh_token:tokens.refresh_token,scope:tokens.scope})+'\n',{mode:0o600});
    await chmod('.local/google-oauth.json',0o600);
    res.end('Google connected to local Cleo. You can close this tab.');
    console.log('Google authorization saved locally.');
  } catch { res.writeHead(400); res.end('Google authorization was not saved. Restart the local authorization command to try again.'); }
  finally { clearTimeout(deadline); server.close(); }
});
const deadline = setTimeout(()=>{console.log('Authorization expired; run the command again.');server.close();},600000);
server.listen(0,'127.0.0.1',()=>{
  const port = server.address().port;
  redirect = `http://127.0.0.1:${port}/callback`;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',
    scope:scopes.join(' '),access_type:'offline',prompt:'consent',state,
    code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  authorization = url.href;
  console.log(`Open http://127.0.0.1:${port}/start to connect Google Docs. No whole-Drive or Calendar access is requested.`);
});
