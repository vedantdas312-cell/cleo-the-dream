import { readFile } from 'node:fs/promises';
export function googleToken({ credentialsPath = '.local/google-oauth.json', clientPath = '.local/google-client.json', accessToken = process.env.GOOGLE_ACCESS_TOKEN, credentialsJson = process.env.CLEO_GOOGLE_OAUTH_JSON, clientJson = process.env.CLEO_GOOGLE_CLIENT_JSON, fetchImpl = fetch } = {}) {
  let cached, expires = 0;
  return async () => {
    if (accessToken) return accessToken;
    if (cached && Date.now() < expires) return cached;
    const saved = JSON.parse(credentialsJson || await readFile(credentialsPath, 'utf8'));
    const client = JSON.parse(clientJson || await readFile(clientPath, 'utf8')).installed;
    if (!client?.client_id || !saved.refresh_token) throw new Error('Run Google authorization first.');
    const response = await fetchImpl('https://oauth2.googleapis.com/token', { method:'POST', redirect:'error',
      signal:AbortSignal.timeout(10000), body:new URLSearchParams({client_id:client.client_id,client_secret:client.client_secret,
        refresh_token:saved.refresh_token,grant_type:'refresh_token'}) });
    if (!response.ok) throw new Error('Google authorization needs to be renewed.');
    const token = await response.json();
    if (!token.access_token) throw new Error('Missing Google access token.');
    cached = token.access_token; expires = Date.now() + Math.max(0,(token.expires_in-60))*1000;
    return cached;
  };
}
