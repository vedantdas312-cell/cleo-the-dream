import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

const directory = new URL('../dist/landing/', import.meta.url);

// Exact public assets only. Never fall back to a filesystem path or the SPA for API requests.
export async function serveLanding(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const home = url.pathname === '/';
  if (!home && !/^\/landing-assets\/[A-Za-z0-9_-]+\.(js|css)$/.test(url.pathname)) return false;
  let bytes: Buffer;
  try { bytes = await readFile(new URL(home ? 'index.html' : url.pathname.slice(1), directory)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  response.setHeader('Content-Type', home ? 'text/html; charset=utf-8' : url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
  response.setHeader('Cache-Control', home ? 'no-cache' : 'public, max-age=31536000, immutable');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  response.setHeader('Content-Length', bytes.length);
  response.writeHead(200);
  response.end(request.method === 'HEAD' ? undefined : bytes);
  return true;
}
