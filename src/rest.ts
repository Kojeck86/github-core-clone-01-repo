// REST v3: repositories, branches, commits, contents, labels, issues, comments and pull
// requests, with the status codes, shapes and pagination the GitHub API surface promises.
// Every reply is JSON and carries an X-GitHub-Request-Id (added by app.ts); a missing or wrong
// bearer token is refused before this handler runs.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildCommit, isAncestor, parseCommit } from './gitcore.ts';
import { diffTrees, flatOf, threeWayMerge } from './diffmerge.ts';
import {
  FIXED_DATE,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  forge,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

function sendJson(res: ServerResponse, status: number, body: JsonValue, extraHeaders: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

function unprocessable(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message });
}

function parseBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function field(value: unknown, name: string): string | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const raw = (value as Record<string, unknown>)[name];
    return typeof raw === 'string' ? raw : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseIsoDate(stamp: string): string {
  const [seconds] = stamp.split(' ');
  const epoch = Number.parseInt(seconds ?? '0', 10);
  if (!Number.isFinite(epoch)) return FIXED_DATE;
  return new Date(epoch * 1000).toISOString();
}

function parseIdent(ident: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+ [+-]\d{4})$/.exec(ident);
  if (!match) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_DATE };
  return { name: match[1] as string, email: match[2] as string, date: parseIsoDate(match[3] as string) };
}

function repoShape(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    pushed_at: FIXED_DATE,
  };
}

function labelShape(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { id: label?.id ?? 0, name, color: label?.color ?? 'ededed', url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}` };
}

function issueShape(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelShape(repo, name)),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    comments: issue.comments.length,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function commentShape(repo: Repo, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.userLogin, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  };
}

function pullShape(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const mergeable = (() => {
    if (pull.merged) return false;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
    if (baseTip === null || headTip === null) return false;
    if (isAncestor(headTip, baseTip, (oid) => repo.objects.get(oid))) return true;
    return threeWayMerge(repo, baseTip, headTip).conflicts.length === 0;
  })();
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  };
}

function commitShape(repo: Repo, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  const author = parseIdent(parsed.author);
  const committer = parseIdent(parsed.committer);
  return {
    sha: oid,
    commit: {
      message: parsed.message,
      author,
      committer,
      tree: { sha: parsed.tree },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
    parents: parsed.parents.map((sha) => ({ sha })),
  };
}

/** Walk a commit's ancestors, tip first, each commit once. */
function commitList(repo: Repo, tip: string | null): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (tip === null) return out;
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const shape = commitShape(repo, oid);
    if (shape === null) continue;
    out.push(shape);
    const object = repo.objects.get(oid);
    if (object && object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) {
        if (!seen.has(parent)) queue.push(parent);
      }
    }
  }
  return out;
}

function repoOr404(res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    notFound(res);
    return null;
  }
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) {
    notFound(res);
    return null;
  }
  return repo;
}

function paginate<T>(res: ServerResponse, req: IncomingMessage, query: URLSearchParams, items: T[]): void {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const protocol = 'http';
    const base = `${protocol}://${host}${req.url?.split('?')[0] ?? ''}`;
    const next = new URLSearchParams(query);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    headers.link = `<${base}?${next.toString()}>; rel="next"`;
  }
  sendJson(res, 200, slice as unknown as JsonValue, headers);
}

function issueByNumber(repo: Repo, raw: string): Issue | undefined {
  const number = Number.parseInt(raw, 10);
  if (!Number.isFinite(number)) return undefined;
  return repo.issues.find((issue) => issue.number === number);
}

function pullByNumber(repo: Repo, raw: string): PullRequest | undefined {
  const number = Number.parseInt(raw, 10);
  if (!Number.isFinite(number)) return undefined;
  return repo.pulls.find((pull) => pull.number === number);
}

export function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  segments: readonly string[],
  query: URLSearchParams,
  body: Buffer,
): boolean {
  const method = req.method ?? 'GET';

  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') return false;
    sendJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_url: '/api/v3/users/{user}',
        rate_limit_url: '/api/v3/rate_limit',
      },
      { 'x-oauth-scopes': 'repo, user' },
    );
    return true;
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return false;
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return false;
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
    return true;
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      paginate(res, req, query, forge.listRepos(VIEWER_LOGIN).map((repo) => repoShape(repo)));
      return true;
    }
    if (method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      const name = field(parsed.value, 'name');
      if (name === undefined || name === '') {
        unprocessable(res, 'Validation Failed: name is required');
        return true;
      }
      if (forge.getRepo(VIEWER_LOGIN, name) !== undefined) {
        unprocessable(res, 'Repository already exists.');
        return true;
      }
      const description = field(parsed.value, 'description') ?? '';
      const isPrivate = isRecord(parsed.value) && parsed.value.private === true;
      const repo = forge.createRepo(VIEWER_LOGIN, name, description, isPrivate);
      sendJson(res, 201, repoShape(repo));
      return true;
    }
    return false;
  }

  // Everything below is /api/v3/repos/{owner}/{repo}/...
  if (segments.length < 3 || segments[0] !== 'repos') return false;
  const owner = decodeURIComponent(segments[1] as string);
  const name = decodeURIComponent(segments[2] as string);
  const tail = segments.slice(3);

  // GET/PATCH/DELETE /api/v3/repos/{owner}/{repo}
  if (tail.length === 0) {
    const repo = repoOr404(res, owner, name);
    if (repo === null) return true;
    if (method === 'GET') {
      sendJson(res, 200, repoShape(repo));
      return true;
    }
    if (method === 'PATCH') {
      const parsed = parseBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      const description = field(parsed.value, 'description');
      if (description !== undefined) repo.description = description;
      sendJson(res, 200, repoShape(repo));
      return true;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      sendJson(res, 204, null);
      return true;
    }
    return false;
  }

  // /git/refs
  if (tail.length >= 2 && tail[0] === 'git' && tail[1] === 'refs') {
    const repo = repoOr404(res, owner, name);
    if (repo === null) return true;
    if (tail.length === 2) {
      if (method === 'GET') {
        const refs = [...repo.refs.keys()].sort().map((ref) => ({ ref, object: { sha: repo.refs.get(ref) } }));
        sendJson(res, 200, refs);
        return true;
      }
      if (method === 'POST') {
        const parsed = parseBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        const ref = field(parsed.value, 'ref');
        const sha = field(parsed.value, 'sha');
        if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
          unprocessable(res, 'Validation Failed: ref and sha are required');
          return true;
        }
        if (repo.refs.has(ref)) {
          unprocessable(res, 'Reference already exists');
          return true;
        }
        if (forge.resolveCommit(repo, sha) === null) {
          unprocessable(res, 'Invalid SHA');
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha } });
        return true;
      }
      return false;
    }
    if (tail.length === 4 && tail[2] === 'heads' && method === 'GET') {
      const branch = decodeURIComponent(tail[3] as string);
      const sha = repo.refs.get(`refs/heads/${branch}`) ?? null;
      if (sha === null) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha } });
      return true;
    }
    return false;
  }

  // /branches
  if (tail.length >= 1 && tail[0] === 'branches') {
    const repo = repoOr404(res, owner, name);
    if (repo === null) return true;
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) }, protected: false }));
      sendJson(res, 200, branches);
      return true;
    }
    if (tail.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(tail[1] as string);
      const sha = repo.refs.get(`refs/heads/${branch}`) ?? null;
      if (sha === null) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
      return true;
    }
    return false;
  }

  // /commits
  if (tail.length === 1 && tail[0] === 'commits') {
    const repo = repoOr404(res, owner, name);
    if (repo === null) return true;
    if (method !== 'GET') return false;
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = forge.resolveCommit(repo, ref);
    if (tip === null && ref !== repo.defaultBranch) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, commitList(repo, tip));
    return true;
  }

  // /contents[/{path...}] — a bare /contents is the repository root directory.
  if (tail.length >= 1 && tail[0] === 'contents') {
    const repo = repoOr404(res, owner, name);
    if (repo === null) return true;
    const path = tail.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
    const branch = query.get('ref') ?? repo.defaultBranch;
    const tip = forge.resolveCommit(repo, branch);
    if (method === 'GET') {
      if (tip === null) {
        notFound(res);
        return true;
      }
      const file = forge.fileAt(repo, tip, path);
      if (file !== null) {
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: file.data.length,
          name: path.split('/').pop(),
          path,
          sha: file.oid,
          content: file.data.toString('base64'),
        });
        return true;
      }
      const dir = forge.dirAt(repo, tip, path);
      if (dir !== null) {
        sendJson(
          res,
          200,
          dir.map((entry) => ({
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name,
            path: entry.path,
            sha: entry.oid,
            size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
          })),
        );
        return true;
      }
      notFound(res);
      return true;
    }
    if (method === 'PUT') {
      const parsed = parseBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      const message = field(parsed.value, 'message') ?? `Update ${path}`;
      const content = field(parsed.value, 'content');
      const sha = field(parsed.value, 'sha');
      const putBranch = field(parsed.value, 'branch') ?? branch;
      if (content === undefined) {
        unprocessable(res, 'Validation Failed: content is required');
        return true;
      }
      const data = Buffer.from(content, 'base64');
      const putTip = forge.resolveCommit(repo, putBranch);
      const existing = putTip === null ? null : forge.fileAt(repo, putTip, path);
      if (existing !== null) {
        if (sha === undefined || sha !== existing.oid) {
          sendJson(res, 409, { message: 'sha does not match' });
          return true;
        }
        const commitOid = forge.commitFiles(repo, putBranch, new Map([[path, data]]), message);
        sendJson(res, 200, {
          content: { name: path.split('/').pop(), path, sha: forge.fileAt(repo, commitOid, path)?.oid ?? '', size: data.length, type: 'file', encoding: 'base64', content: data.toString('base64') },
          commit: { sha: commitOid, message },
        });
        return true;
      }
      const commitOid = forge.commitFiles(repo, putBranch, new Map([[path, data]]), message);
      sendJson(res, 201, {
        content: { name: path.split('/').pop(), path, sha: forge.fileAt(repo, commitOid, path)?.oid ?? '', size: data.length, type: 'file', encoding: 'base64', content: data.toString('base64') },
        commit: { sha: commitOid, message },
      });
      return true;
    }
    if (method === 'DELETE') {
      const parsed = parseBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      const message = field(parsed.value, 'message') ?? `Delete ${path}`;
      const sha = field(parsed.value, 'sha');
      if (tip === null) {
        notFound(res);
        return true;
      }
      const existing = forge.fileAt(repo, tip, path);
      if (existing === null) {
        notFound(res);
        return true;
      }
      if (sha === undefined || sha !== existing.oid) {
        sendJson(res, 409, { message: 'sha does not match' });
        return true;
      }
      const commitOid = forge.deleteFile(repo, branch, path, message);
      if (commitOid === null) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { commit: { sha: commitOid, message } });
      return true;
    }
    return false;
  }

  // /labels
  if (tail.length === 1 && tail[0] === 'labels') {
    const repo = repoOr404(res, owner, name);
    if (repo === null) return true;
    if (method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      const labelName = field(parsed.value, 'name');
      const color = field(parsed.value, 'color') ?? 'ededed';
      if (labelName === undefined || labelName === '') {
        unprocessable(res, 'Validation Failed: name is required');
        return true;
      }
      if (repo.labels.has(labelName)) {
        unprocessable(res, 'Validation Failed: label already exists');
        return true;
      }
      repo.labelSeq += 1;
      repo.labels.set(labelName, { id: repo.labelSeq, name: labelName, color });
      sendJson(res, 201, labelShape(repo, labelName));
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label) => ({ id: label.id, name: label.name, color: label.color })));
      return true;
    }
    return false;
  }

  // /issues and /issues/{n}[/comments]
  if (tail.length >= 1 && tail[0] === 'issues') {
    const repo = repoOr404(res, owner, name);
    if (repo === null) return true;
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
        if (sort === 'created') {
          issues = [...issues].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        }
        sendJson(res, 200, issues.map((issue) => issueShape(repo, issue)));
        return true;
      }
      if (method === 'POST') {
        const parsed = parseBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        const title = field(parsed.value, 'title');
        const issueBody = field(parsed.value, 'body') ?? '';
        if (title === undefined || title === '') {
          unprocessable(res, 'Validation Failed: title is required');
          return true;
        }
        const labelsRaw = isRecord(parsed.value) && Array.isArray(parsed.value.labels) ? (parsed.value.labels as unknown[]) : [];
        const labels: string[] = [];
        for (const raw of labelsRaw) {
          if (typeof raw !== 'string') continue;
          if (!repo.labels.has(raw)) {
            unprocessable(res, `Validation Failed: label ${raw} does not exist`);
            return true;
          }
          labels.push(raw);
        }
        repo.issueSeq += 1;
        const issue: Issue = {
          id: forge.nextIssueId(),
          number: repo.issueSeq,
          title,
          body: issueBody,
          state: 'open',
          labels,
          seq: repo.issueSeq,
          comments: [],
        };
        repo.issues.push(issue);
        sendJson(res, 201, issueShape(repo, issue));
        return true;
      }
      return false;
    }
    const issue = issueByNumber(repo, tail[1] as string);
    if (tail.length === 2) {
      if (issue === undefined) {
        notFound(res);
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueShape(repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        const parsed = parseBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        const state = field(parsed.value, 'state');
        if (state === 'closed' || state === 'open') issue.state = state;
        const title = field(parsed.value, 'title');
        if (title !== undefined) issue.title = title;
        const issueBody = field(parsed.value, 'body');
        if (issueBody !== undefined) issue.body = issueBody;
        sendJson(res, 200, issueShape(repo, issue));
        return true;
      }
      return false;
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (issue === undefined) {
        notFound(res);
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => commentShape(repo, comment)));
        return true;
      }
      if (method === 'POST') {
        const parsed = parseBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        const commentBody = field(parsed.value, 'body');
        if (commentBody === undefined || commentBody === '') {
          unprocessable(res, 'Validation Failed: body is required');
          return true;
        }
        repo.commentSeq += 1;
        const comment = { id: repo.commentSeq, body: commentBody, userLogin: VIEWER_LOGIN, seq: repo.commentSeq };
        issue.comments.push(comment);
        sendJson(res, 201, commentShape(repo, comment));
        return true;
      }
      return false;
    }
    return false;
  }

  // /pulls, /pulls/{n}, /pulls/{n}/files, /pulls/{n}/merge
  if (tail.length >= 1 && tail[0] === 'pulls') {
    const repo = repoOr404(res, owner, name);
    if (repo === null) return true;
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
        sendJson(res, 200, pulls.map((pull) => pullShape(repo, pull)));
        return true;
      }
      if (method === 'POST') {
        const parsed = parseBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        const title = field(parsed.value, 'title');
        const head = field(parsed.value, 'head');
        const base = field(parsed.value, 'base');
        const prBody = field(parsed.value, 'body') ?? '';
        if (title === undefined || head === undefined || base === undefined) {
          unprocessable(res, 'Validation Failed: title, head and base are required');
          return true;
        }
        const headSha = forge.resolveCommit(repo, head);
        const baseSha = forge.resolveCommit(repo, base);
        if (headSha === null || baseSha === null) {
          unprocessable(res, 'Validation Failed: head or base does not exist');
          return true;
        }
        repo.pullSeq += 1;
        const pull: PullRequest = {
          id: forge.nextPullId(),
          number: repo.pullSeq,
          title,
          body: prBody,
          state: 'open',
          headRef: head,
          baseRef: base,
          headSha,
          baseSha,
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          seq: repo.pullSeq,
        };
        repo.pulls.push(pull);
        sendJson(res, 201, pullShape(repo, pull));
        return true;
      }
      return false;
    }
    const pull = pullByNumber(repo, tail[1] as string);
    if (tail.length === 2) {
      if (pull === undefined) {
        notFound(res);
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, pullShape(repo, pull));
        return true;
      }
      return false;
    }
    if (tail.length === 3 && tail[2] === 'files') {
      if (pull === undefined) {
        notFound(res);
        return true;
      }
      if (method !== 'GET') return false;
      const changes = diffTrees(repo, flatOf(repo, pull.baseSha), flatOf(repo, pull.headSha));
      sendJson(
        res,
        200,
        changes.map((change) => ({
          filename: change.filename,
          status: change.status === 'removed' ? 'removed' : change.status === 'added' ? 'added' : 'modified',
          additions: change.additions,
          deletions: change.deletions,
          changes: change.changes,
        })),
      );
      return true;
    }
    if (tail.length === 3 && tail[2] === 'merge') {
      if (pull === undefined) {
        notFound(res);
        return true;
      }
      if (method !== 'PUT') return false;
      if (pull.merged) {
        sendJson(res, 405, { message: 'Pull request is already merged' });
        return true;
      }
      const parsed = parseBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      const mergeMethod = field(parsed.value, 'merge_method') ?? 'merge';
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
      if (baseTip === null || headTip === null) {
        notFound(res, 'head or base branch not found');
        return true;
      }
      const outcome = threeWayMerge(repo, baseTip, headTip);
      if (outcome.mergedFlat === null) {
        sendJson(res, 405, { message: 'Merge conflict' });
        return true;
      }
      const treeOid = forge.buildTreeFromFlat(repo, outcome.mergedFlat);
      const stamp = forge.nextCommitStamp();
      const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${stamp}`;
      const parents = mergeMethod === 'merge' ? [baseTip, headTip] : [baseTip];
      const message = mergeMethod === 'merge' ? `Merge pull request #${pull.number} from ${pull.headRef}` : pull.title;
      const commitData = buildCommit({
        tree: treeOid,
        parents,
        author: ident,
        committer: ident,
        message,
      });
      const mergeSha = forge.putObject(repo, 'commit', commitData);
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = FIXED_DATE;
      pull.mergeCommitSha = mergeSha;
      sendJson(res, 200, { sha: mergeSha, merged: true, message });
      return true;
    }
    return false;
  }

  return false;
}
