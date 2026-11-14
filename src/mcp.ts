// MCP over POST /mcp: streamable HTTP, plain JSON replies. server/discover for the modern
// era, initialize for the legacy eras, tools/list (byte-identical every time) and tools/call
// for the six forge tools, whose effects are the same objects the REST view reads. JSON-RPC
// ids are echoed exactly, including string ids, so concurrent calls keep their own answers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN, forge } from './store.ts';
import { doMerge } from './graphql.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const SERVER_NAME = 'github-core-clone-01-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required },
  };
}

const TOOLS: readonly ToolDefinition[] = [
  tool(
    'create_repo',
    'Create a new repository for the authenticated user.',
    {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get a repository by owner and name.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List the issues of a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.', enum: ['open', 'closed', 'all'] },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Create a pull request from a head branch into a base branch.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Merge a pull request by number, using the squash method.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
];

function textResult(text: string, structured: Record<string, unknown> = {}): Record<string, unknown> {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function errorResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

function missingArg(name: string): Record<string, unknown> {
  return errorResult(`missing required argument: ${name}`);
}

function pickArg(args: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function resolveRepo(args: Record<string, unknown>): { owner: string; repoName: string } | null {
  const owner = pickArg(args, ['owner', 'owner_login']);
  const repoName = pickArg(args, ['repo', 'repository']);
  if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
  if (owner !== VIEWER_LOGIN) return null;
  return { owner, repoName };
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = name.toLowerCase();
  const matched = TOOLS.find((candidate) => candidate.name === normalized || normalized.endsWith(candidate.name));
  if (matched === undefined) return errorResult(`unknown tool: ${name}`);
  const toolName = matched.name;

  if (toolName === 'create_repo') {
    const repoName = pickArg(args, ['name']);
    if (typeof repoName !== 'string' || repoName === '') return missingArg('name');
    const description = typeof args.description === 'string' ? args.description : '';
    const isPrivate = args.private === true;
    if (forge.getRepo(VIEWER_LOGIN, repoName) !== undefined) {
      return errorResult(`repository ${VIEWER_LOGIN}/${repoName} already exists`);
    }
    const repo = forge.createRepo(VIEWER_LOGIN, repoName, description, isPrivate);
    return textResult(`Created repository ${repo.owner}/${repo.name} (id ${repo.id}).`, {
      name: repo.name,
      owner: repo.owner,
      full_name: `${repo.owner}/${repo.name}`,
      private: repo.private,
      default_branch: repo.defaultBranch,
    });
  }

  if (toolName === 'get_repo') {
    const target = resolveRepo(args);
    if (target === null) return missingArg('owner or repo');
    const repo = forge.getRepo(target.owner, target.repoName);
    if (repo === undefined) return errorResult(`repository ${target.owner}/${target.repoName} not found`);
    return textResult(
      `Repository ${repo.owner}/${repo.name}: ${repo.description === '' ? '(no description)' : repo.description} (default branch ${repo.defaultBranch}, private ${repo.private}).`,
      { name: repo.name, owner: repo.owner, full_name: `${repo.owner}/${repo.name}`, private: repo.private, default_branch: repo.defaultBranch },
    );
  }

  if (toolName === 'create_issue') {
    const target = resolveRepo(args);
    if (target === null) return missingArg('owner or repo');
    const title = pickArg(args, ['title']);
    if (typeof title !== 'string' || title === '') return missingArg('title');
    const body = typeof args.body === 'string' ? args.body : '';
    const repo = forge.getRepo(target.owner, target.repoName);
    if (repo === undefined) return errorResult(`repository ${target.owner}/${target.repoName} not found`);
    repo.issueSeq += 1;
    const issue = {
      id: forge.nextIssueId(),
      number: repo.issueSeq,
      title,
      body,
      state: 'open' as const,
      labels: [] as string[],
      seq: repo.issueSeq,
      comments: [],
    };
    repo.issues.push(issue);
    return textResult(`Created issue #${issue.number}: ${title} in ${repo.owner}/${repo.name}.`, {
      number: issue.number,
      title,
      state: 'open',
      id: issue.id,
    });
  }

  if (toolName === 'list_issues') {
    const target = resolveRepo(args);
    if (target === null) return missingArg('owner or repo');
    const repo = forge.getRepo(target.owner, target.repoName);
    if (repo === undefined) return errorResult(`repository ${target.owner}/${target.repoName} not found`);
    const state = typeof args.state === 'string' ? args.state : 'open';
    const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    const lines = issues.map((issue) => `#${issue.number} ${issue.title} (${issue.state})`);
    const text = lines.length === 0 ? `No issues in ${repo.owner}/${repo.name}.` : `Issues in ${repo.owner}/${repo.name}:\n${lines.join('\n')}`;
    return textResult(text, { issues: issues.map((issue) => ({ number: issue.number, title: issue.title, state: issue.state })) });
  }

  if (toolName === 'create_pull_request') {
    const target = resolveRepo(args);
    if (target === null) return missingArg('owner or repo');
    const title = pickArg(args, ['title']);
    if (typeof title !== 'string' || title === '') return missingArg('title');
    const head = pickArg(args, ['head', 'head_ref']);
    const base = pickArg(args, ['base', 'base_ref']);
    if (typeof head !== 'string' || head === '') return missingArg('head');
    if (typeof base !== 'string' || base === '') return missingArg('base');
    const repo = forge.getRepo(target.owner, target.repoName);
    if (repo === undefined) return errorResult(`repository ${target.owner}/${target.repoName} not found`);
    const headSha = forge.resolveCommit(repo, head);
    const baseSha = forge.resolveCommit(repo, base);
    if (headSha === null || baseSha === null) return errorResult('head or base branch not found');
    repo.pullSeq += 1;
    const pull = {
      id: forge.nextPullId(),
      number: repo.pullSeq,
      title,
      body: '',
      state: 'open' as const,
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
    return textResult(`Created pull request #${pull.number}: ${title} (${head} -> ${base}) in ${repo.owner}/${repo.name}.`, {
      number: pull.number,
      title,
      state: 'open',
      head,
      base,
    });
  }

  if (toolName === 'merge_pull_request') {
    const target = resolveRepo(args);
    if (target === null) return missingArg('owner or repo');
    const pullNumber = pickArg(args, ['pull_number', 'pull_request_number', 'number']);
    if (typeof pullNumber !== 'number') return missingArg('pull_number');
    const repo = forge.getRepo(target.owner, target.repoName);
    if (repo === undefined) return errorResult(`repository ${target.owner}/${target.repoName} not found`);
    const pull = repo.pulls.find((candidate) => candidate.number === pullNumber);
    if (pull === undefined) return errorResult(`pull request #${pullNumber} not found`);
    const result = doMerge(repo, pull, 'SQUASH');
    if (!result.ok) return errorResult(result.message ?? 'merge failed');
    return textResult(`Merged pull request #${pull.number}: ${pull.title} in ${repo.owner}/${repo.name} (merge commit ${pull.mergeCommitSha}).`, {
      number: pull.number,
      merged: true,
      merge_commit_sha: pull.mergeCommitSha,
    });
  }

  return errorResult(`unknown tool: ${name}`);
}

export function handleMcp(req: IncomingMessage, res: ServerResponse, segments: readonly string[], body: Buffer): boolean {
  if (segments.length !== 0) return false;
  if ((req.method ?? 'GET') !== 'POST') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const record = parsed as Record<string, unknown>;
  const id = record.id === undefined ? null : record.id;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and get no reply body.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return true;
  }

  const respond = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  };
  const respondError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };

  if (method === 'server/discover') {
    respond({
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      protocolVersion: '2026-07-28',
    });
    return true;
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    respond({
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return true;
  }

  if (method === 'ping') {
    respond({});
    return true;
  }

  if (method === 'tools/list') {
    respond({ tools: TOOLS });
    return true;
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const rawArgs = params.arguments;
    if (rawArgs !== undefined && (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
      respondError(-32602, 'tools/call arguments must be an object');
      return true;
    }
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const known = TOOLS.some((candidate) => candidate.name === toolName.toLowerCase() || toolName.toLowerCase().endsWith(candidate.name));
    if (toolName === '' || !known) {
      respondError(-32602, `unknown tool: ${toolName}`);
      return true;
    }
    respond(callTool(toolName, args));
    return true;
  }

  respondError(-32601, `method not found: ${method}`);
  return true;
}
