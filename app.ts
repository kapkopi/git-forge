// The server: one node:http listener, one Forge, four surfaces. Routing is string operations on
// the path (no per-request regex on the hot path), auth is one precomputed string comparison,
// and every response carries a Content-Length and an X-GitHub-Request-Id. A handler that throws
// answers 500 and the server keeps serving: nothing in a request may end the process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './gitproto.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Forge } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      req.destroy();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, requestId: string, status: number, json: unknown, extra?: Record<string, string>): void {
  const body = `${JSON.stringify(json)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-github-request-id': requestId,
    ...extra,
  });
  res.end(body);
}

function sendEmpty(res: ServerResponse, requestId: string, status: number, extra?: Record<string, string>): void {
  res.writeHead(status, { 'x-github-request-id': requestId, ...extra });
  res.end();
}

function sendBytes(res: ServerResponse, requestId: string, status: number, body: Buffer, extra?: Record<string, string>): void {
  res.writeHead(status, {
    'content-length': body.length,
    'x-github-request-id': requestId,
    ...extra,
  });
  res.end(body);
}

/** True when the path names a git endpoint: /{owner}/{repo}.git/{endpoint}. */
function isGitPath(pathname: string): boolean {
  const slash1 = pathname.indexOf('/', 1);
  if (slash1 <= 1) return false;
  const slash2 = pathname.indexOf('/', slash1 + 1);
  if (slash2 <= slash1 + 1) return false;
  return pathname.slice(slash1 + 1, slash2).endsWith('.git');
}

export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const expectedAuth = `Bearer ${token}`;
  const hasToken = token !== '';
  let requestCounter = 0;

  const server = createServer((req, res) => {
    void (async () => {
      const requestId = `forge-${(requestCounter += 1)}`;
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        if (pathname === '/healthz' && method === 'GET') {
          sendJson(res, requestId, 200, { ok: true });
          return;
        }

        const authorized = hasToken && req.headers.authorization === expectedAuth;
        const body = await readBody(req);
        if (body === null) {
          sendJson(res, requestId, 413, { message: 'Request body too large' });
          return;
        }

        if (pathname === '/api/graphql') {
          const result = handleGraphql({ forge, method, body, authorized });
          sendJson(res, requestId, result.status, result.json);
          return;
        }
        if (pathname === '/mcp') {
          const result = handleMcp({ forge, method, body, authorized });
          if (result.empty === true) sendEmpty(res, requestId, result.status);
          else sendJson(res, requestId, result.status, result.json);
          return;
        }
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          const restPath = pathname.slice('/api/v3'.length) || '/';
          const result = handleRest({
            forge,
            method,
            path: restPath,
            query: url.searchParams,
            body,
            host: req.headers.host ?? 'localhost',
            authorized,
          });
          if (result.empty === true) sendEmpty(res, requestId, result.status, result.headers);
          else sendJson(res, requestId, result.status, result.json, result.headers);
          return;
        }
        if (isGitPath(pathname)) {
          const result = handleGit({
            forge,
            method,
            path: pathname,
            query: url.searchParams,
            headers: req.headers,
            body,
            authorized,
          });
          sendBytes(res, requestId, result.status, result.body, result.headers);
          return;
        }
        sendJson(res, requestId, 404, { message: 'Not Found' });
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, requestId, 500, { message: 'Internal Server Error' });
        } else {
          res.end();
        }
        process.stderr.write(`[forge] request failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    })();
  });

  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });

  return server;
}
