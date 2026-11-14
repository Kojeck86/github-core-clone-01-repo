// The HTTP server: one process, one forge. Routes are tried in order — /healthz (no auth),
// /api/graphql, /api/v3/*, /mcp, then the git smart-HTTP paths — and anything else is a JSON
// 404. Every API route requires Authorization: Bearer $MAKEFUN_SHOP_TOKEN; a missing or wrong
// token is refused with 401 before any handler runs. Every reply carries a deterministic
// X-GitHub-Request-Id ("req-1", "req-2", ...), never a clock or a random value.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit, gitSegments } from './src/githttp.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return false;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${expected}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Dispatch one request. The request id is attached to every response with setHeader, so the
 * handlers' own writeHead calls carry it without any per-request wrapping.
 */
async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = nextRequestId();
  res.setHeader('x-github-request-id', requestId);

  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const segments = pathname.split('/').filter((segment) => segment !== '');
  const method = req.method ?? 'GET';

  if (pathname === '/healthz') {
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET and HEAD never carry a body in this API; reading one would only add a round trip
  // through the stream for every read.
  const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

  if (pathname === '/api/graphql') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (!handleGraphql(req, res, ['graphql'], body)) sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (segments.length >= 1 && segments[0] === 'api' && segments[1] === 'v3') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (!handleRest(req, res, segments.slice(2), url.searchParams, body)) sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (pathname === '/mcp') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (!handleMcp(req, res, [], body)) sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (!handleGit(req, res, gitSegments(pathname), url.searchParams, body)) sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

export function createApp(): Server {
  const server = createServer((req, res) => {
    dispatch(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
        } catch {
          res.destroy();
        }
      } else {
        res.destroy();
      }
    });
  });
  return server;
}
