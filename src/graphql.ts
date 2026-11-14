// GraphQL over POST /api/graphql: a small recursive-descent parser and executor for the
// documents the conformance checks and the MCP client send — viewer, repository, issues,
// pull requests, __type introspection, node by global id, the five mutations, and JSON batching.
// Global ids are base64 of a typed key ("Repository:owner/name", "Issue:owner/repo:n",
// "PullRequest:owner/repo:n"): opaque, stable across reads, never a bare number.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { diffTrees, flatOf, threeWayMerge } from './diffmerge.ts';
import { buildCommit } from './gitcore.ts';
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/* ------------------------------------------------------------------ ids */

function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', `${repo.owner}/${repo.name}`);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.owner}/${repo.name}:${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return globalId('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`);
}

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function seqFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function findByGlobalId(id: string): { repo: Repo; issue?: Issue; pull?: PullRequest } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const [owner, name] = decoded.key.split('/');
    if (owner === undefined || name === undefined) return null;
    const repo = forge.getRepo(owner, name);
    return repo === undefined ? null : { repo };
  }
  const match = /^([^/]+)\/([^:]+):(\d+)$/.exec(decoded.key);
  if (match === null) return null;
  const repo = forge.getRepo(match[1] as string, match[2] as string);
  if (repo === undefined) return null;
  const number = Number.parseInt(match[3] as string, 10);
  if (decoded.kind === 'Issue') {
    const issue = repo.issues.find((candidate) => candidate.number === number);
    return issue === undefined ? null : { repo, issue };
  }
  if (decoded.kind === 'PullRequest') {
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    return pull === undefined ? null : { repo, pull };
  }
  return null;
}

/* ------------------------------------------------------------------ lexer */

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch.charCodeAt(0) === 0xfeff) {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const escaped = source[j + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

/* ------------------------------------------------------------------ parser */

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldSelection {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: Value }>;
  readonly selections: Selection[] | null;
}

interface FragmentSpread {
  readonly kind: 'spread';
  readonly name: string;
}

interface InlineFragment {
  readonly kind: 'inline';
  readonly typeCondition: string | null;
  readonly selections: Selection[];
}

type Selection = FieldSelection | FragmentSpread | InlineFragment;

interface Operation {
  readonly operation: 'query' | 'mutation';
  readonly name: string | null;
  readonly variableDefinitions: Array<{ name: string; defaultValue: Value | null }>;
  readonly selections: Selection[];
}

interface FragmentDefinition {
  readonly name: string;
  readonly typeCondition: string;
  readonly selections: Selection[];
}

interface Document {
  readonly operations: Operation[];
  readonly fragments: Map<string, FragmentDefinition>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected name');
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}`);
    return token.value;
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDefinition>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = token.value;
      this.next();
      const next = this.peek();
      if (next.kind === 'name') name = this.next().value as string;
    }
    const variableDefinitions: Array<{ name: string; defaultValue: Value | null }> = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: Value | null = null;
        if (this.acceptPunct('=')) defaultValue = this.parseValue();
        variableDefinitions.push({ name: varName, defaultValue });
      }
    }
    const selections = this.parseSelectionSet();
    return { operation, name, variableDefinitions, selections };
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        return { kind: 'spread', name: this.next().value as string };
      }
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    // Directives: parsed and ignored.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.acceptPunct('(')) {
        while (!this.acceptPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
    let selections: Selection[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }
}

/* ------------------------------------------------------------------ values */

type Variables = Record<string, unknown>;

function resolveValue(value: Value, variables: Variables): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldSelection, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

/* ------------------------------------------------------------------ schema */

const SCHEMA_TYPES: Record<string, { kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INPUT_OBJECT'; fields?: string[]; enumValues?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'] },
  Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'] },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'labels', 'comments', 'url'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'mergedAt', 'mergeCommit'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'filename', 'additions', 'deletions', 'changes', 'status'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'target'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrder: { kind: 'INPUT_OBJECT', fields: ['field', 'direction'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
};

/* ------------------------------------------------------------------ executor */

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

interface Context {
  readonly errors: Array<{ message: string }>;
  readonly fragments: Map<string, FragmentDefinition>;
  readonly variables: Variables;
}

function expandSelections(selections: readonly Selection[], ctx: Context, typeName: string | null): FieldSelection[] {
  const out: FieldSelection[] = [];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out.push(selection);
    } else if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) out.push(...expandSelections(fragment.selections, ctx, fragment.typeCondition));
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        out.push(...expandSelections(selection.selections, ctx, selection.typeCondition ?? typeName));
      }
    }
  }
  return out;
}

function executeSelections(obj: GqlObject, selections: readonly Selection[], ctx: Context): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of expandSelections(selections, ctx, obj.__typename)) {
    const key = field.alias ?? field.name;
    out[key] = executeField(obj, field, ctx);
  }
  return out;
}

function executeField(obj: GqlObject, field: FieldSelection, ctx: Context): unknown {
  if (field.name === '__typename') return obj.__typename;
  const resolver = RESOLVERS[obj.__typename]?.[field.name];
  if (resolver === undefined) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${obj.__typename}".` });
    return null;
  }
  const args = argsOf(field, ctx.variables);
  const value = resolver(obj, args, ctx);
  return resolveValueWithSelections(value, field, ctx);
}

function resolveValueWithSelections(value: unknown, field: FieldSelection, ctx: Context): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => resolveValueWithSelections(item, field, ctx));
  if (typeof value === 'object' && (value as GqlObject).__typename !== undefined) {
    if (field.selections === null) return value;
    return executeSelections(value as GqlObject, field.selections, ctx);
  }
  return value;
}

type Resolver = (obj: GqlObject, args: Record<string, unknown>, ctx: Context) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {};

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', __repo: repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullObject(repo: Repo, pull: PullRequest): GqlObject {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function userObject(): GqlObject {
  return { __typename: 'User', __login: VIEWER_LOGIN };
}

function refObject(name: string): GqlObject {
  return { __typename: 'Ref', __name: name };
}

function pageInfoObject(hasNextPage: boolean, startCursor: string | null, endCursor: string | null): GqlObject {
  return { __typename: 'PageInfo', __hasNextPage: hasNextPage, __startCursor: startCursor, __endCursor: endCursor };
}

function connectionObject(typeName: string, nodes: GqlObject[], cursors: Array<string | null>, hasNextPage: boolean): GqlObject {
  const edges = nodes.map((node, index) => ({
    __typename: typeName === 'IssueConnection' ? 'IssueEdge' : typeName === 'PullRequestConnection' ? 'PullRequestEdge' : typeName === 'PullRequestChangedFileConnection' ? 'PullRequestChangedFileEdge' : 'IssueCommentEdge',
    __node: node,
    __cursor: cursors[index] ?? null,
  }));
  return {
    __typename: typeName,
    __nodes: nodes,
    __edges: edges,
    __pageInfo: pageInfoObject(hasNextPage, cursors[0] ?? null, cursors[cursors.length - 1] ?? null),
    __totalCount: nodes.length,
  };
}

function sortedIssues(repo: Repo, args: Record<string, unknown>): Issue[] {
  let issues = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = String(orderBy.direction ?? 'DESC');
  issues.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    const seq = seqFromCursor(after);
    if (seq !== null) {
      const index = issues.findIndex((issue) => issue.seq === seq);
      if (index >= 0) issues = issues.slice(index + 1);
    }
  }
  return issues;
}

function mergeableOf(repo: Repo, pull: PullRequest): string {
  if (pull.merged) return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  if (baseTip === headTip) return 'MERGEABLE';
  return threeWayMerge(repo, baseTip, headTip).conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
}

export function doMerge(repo: Repo, pull: PullRequest, method: string): { ok: boolean; message?: string } {
  if (pull.merged) return { ok: false, message: 'already merged' };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
  if (baseTip === null || headTip === null) return { ok: false, message: 'head or base not found' };
  const outcome = threeWayMerge(repo, baseTip, headTip);
  if (outcome.mergedFlat === null) return { ok: false, message: 'Merge conflict' };
  const treeOid = forge.buildTreeFromFlat(repo, outcome.mergedFlat);
  const stamp = forge.nextCommitStamp();
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${stamp}`;
  const parents = method === 'MERGE' ? [baseTip, headTip] : [baseTip];
  const message = method === 'MERGE' ? `Merge pull request #${pull.number} from ${pull.headRef}` : pull.title;
  const commitData = buildCommit({ tree: treeOid, parents, author: ident, committer: ident, message });
  const mergeSha = forge.putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_DATE;
  pull.mergeCommitSha = mergeSha;
  return { ok: true };
}

RESOLVERS.Query = {
  viewer: () => userObject(),
  repository: (_obj, args) => {
    const owner = args.owner;
    const name = args.name;
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    if (owner !== VIEWER_LOGIN) return null;
    const repo = forge.getRepo(owner, name);
    return repo === undefined ? null : repoObject(repo);
  },
  node: (_obj, args) => {
    const id = args.id;
    if (typeof id !== 'string') return null;
    const found = findByGlobalId(id);
    if (found === null) return null;
    if (found.issue !== undefined) return issueObject(found.repo, found.issue);
    if (found.pull !== undefined) return pullObject(found.repo, found.pull);
    return repoObject(found.repo);
  },
  __type: (_obj, args) => {
    const name = args.name;
    if (typeof name !== 'string') return null;
    const type = SCHEMA_TYPES[name];
    if (type === undefined) return null;
    return { __typename: '__Type', __typeName: name, __kind: type.kind };
  },
};

/** Mutations take one `input:` object; read a field from it, or from the top level as a fallback. */
function mutationInput(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>;
  return args;
}

RESOLVERS.Mutation = {
  createIssue: (_obj, args, ctx) => {
    const input = mutationInput(args);
    const repositoryId = input.repositoryId;
    if (typeof repositoryId !== 'string') return null;
    const found = findByGlobalId(repositoryId);
    if (found === null) return null;
    const repo = found.repo;
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    repo.issueSeq += 1;
    const issue: Issue = {
      id: forge.nextIssueId(),
      number: repo.issueSeq,
      title,
      body,
      state: 'open',
      labels: [],
      seq: repo.issueSeq,
      comments: [],
    };
    repo.issues.push(issue);
    void ctx;
    return { __typename: 'CreateIssuePayload', __issue: issueObject(repo, issue) };
  },
  closeIssue: (_obj, args) => {
    const input = mutationInput(args);
    const issueId = input.issueId;
    if (typeof issueId !== 'string') return null;
    const found = findByGlobalId(issueId);
    if (found === null || found.issue === undefined) return null;
    found.issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', __issue: issueObject(found.repo, found.issue) };
  },
  createPullRequest: (_obj, args) => {
    const input = mutationInput(args);
    const repositoryId = input.repositoryId;
    if (typeof repositoryId !== 'string') return null;
    const found = findByGlobalId(repositoryId);
    if (found === null) return null;
    const repo = found.repo;
    const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
    const title = typeof input.title === 'string' ? input.title : '';
    const headSha = forge.resolveCommit(repo, headRefName);
    const baseSha = forge.resolveCommit(repo, baseRefName);
    if (headSha === null || baseSha === null) return null;
    repo.pullSeq += 1;
    const pull: PullRequest = {
      id: forge.nextPullId(),
      number: repo.pullSeq,
      title,
      body: '',
      state: 'open',
      headRef: headRefName,
      baseRef: baseRefName,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: repo.pullSeq,
    };
    repo.pulls.push(pull);
    return { __typename: 'CreatePullRequestPayload', __pull: pullObject(repo, pull) };
  },
  mergePullRequest: (_obj, args, ctx) => {
    const input = mutationInput(args);
    const pullRequestId = input.pullRequestId;
    if (typeof pullRequestId !== 'string') return null;
    const found = findByGlobalId(pullRequestId);
    if (found === null || found.pull === undefined) return null;
    const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
    const result = doMerge(found.repo, found.pull, method);
    if (!result.ok) {
      ctx.errors.push({ message: result.message ?? 'merge failed' });
      return { __typename: 'MergePullRequestPayload', __pull: pullObject(found.repo, found.pull) };
    }
    return { __typename: 'MergePullRequestPayload', __pull: pullObject(found.repo, found.pull) };
  },
  addComment: (_obj, args) => {
    const input = mutationInput(args);
    const subjectId = input.subjectId;
    const body = typeof input.body === 'string' ? input.body : '';
    if (typeof subjectId !== 'string') return null;
    const found = findByGlobalId(subjectId);
    if (found === null || found.issue === undefined) return null;
    const repo = found.repo;
    repo.commentSeq += 1;
    const comment = { id: repo.commentSeq, body, userLogin: VIEWER_LOGIN, seq: repo.commentSeq };
    found.issue.comments.push(comment);
    const node: GqlObject = { __typename: 'IssueComment', __comment: comment };
    return {
      __typename: 'AddCommentPayload',
      __commentEdge: { __typename: 'IssueCommentEdge', __node: node, __cursor: cursorFor(comment.seq) },
    };
  },
};

RESOLVERS.User = {
  id: (obj) => globalId('User', String(obj.__login ?? VIEWER_LOGIN)),
  login: (obj) => String(obj.__login ?? VIEWER_LOGIN),
  name: () => VIEWER_NAME,
  email: () => VIEWER_EMAIL,
};

RESOLVERS.Repository = {
  id: (obj) => repoGlobalId(obj.__repo as Repo),
  databaseId: (obj) => (obj.__repo as Repo).id,
  name: (obj) => (obj.__repo as Repo).name,
  nameWithOwner: (obj) => `${(obj.__repo as Repo).owner}/${(obj.__repo as Repo).name}`,
  owner: () => userObject(),
  defaultBranchRef: (obj) => refObject((obj.__repo as Repo).defaultBranch),
  viewerPermission: () => 'ADMIN',
  hasIssuesEnabled: () => true,
  issue: (obj, args) => {
    const repo = obj.__repo as Repo;
    const number = typeof args.number === 'number' ? args.number : -1;
    const issue = repo.issues.find((candidate) => candidate.number === number);
    return issue === undefined ? null : issueObject(repo, issue);
  },
  issues: (obj, args) => {
    const repo = obj.__repo as Repo;
    const sorted = sortedIssues(repo, args);
    const first = typeof args.first === 'number' ? args.first : sorted.length;
    const page = sorted.slice(0, first);
    const hasNextPage = sorted.length > first;
    return connectionObject(
      'IssueConnection',
      page.map((issue) => issueObject(repo, issue)),
      page.map((issue) => cursorFor(issue.seq)),
      hasNextPage,
    );
  },
  pullRequests: (obj, args) => {
    const repo = obj.__repo as Repo;
    const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
    const page = repo.pulls.slice(0, first);
    return connectionObject(
      'PullRequestConnection',
      page.map((pull) => pullObject(repo, pull)),
      page.map((pull) => cursorFor(pull.seq)),
      repo.pulls.length > first,
    );
  },
  pullRequest: (obj, args) => {
    const repo = obj.__repo as Repo;
    const number = typeof args.number === 'number' ? args.number : -1;
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    return pull === undefined ? null : pullObject(repo, pull);
  },
};

RESOLVERS.Issue = {
  id: (obj) => issueGlobalId(obj.__repo as Repo, obj.__issue as Issue),
  number: (obj) => (obj.__issue as Issue).number,
  title: (obj) => (obj.__issue as Issue).title,
  state: (obj) => ((obj.__issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
  body: (obj) => (obj.__issue as Issue).body,
  labels: (obj) => {
    const repo = obj.__repo as Repo;
    const issue = obj.__issue as Issue;
    return connectionObject(
      'LabelConnection',
      issue.labels.map((name) => ({ __typename: 'Label', __name: name, __color: repo.labels.get(name)?.color ?? 'ededed' })),
      issue.labels.map(() => null),
      false,
    );
  },
  comments: (obj) => {
    const issue = obj.__issue as Issue;
    return connectionObject(
      'IssueCommentConnection',
      issue.comments.map((comment) => ({ __typename: 'IssueComment', __comment: comment })),
      issue.comments.map((comment) => cursorFor(comment.seq)),
      false,
    );
  },
  url: (obj) => `https://example.invalid/${(obj.__repo as Repo).owner}/${(obj.__repo as Repo).name}/issues/${(obj.__issue as Issue).number}`,
};

RESOLVERS.PullRequest = {
  id: (obj) => pullGlobalId(obj.__repo as Repo, obj.__pull as PullRequest),
  number: (obj) => (obj.__pull as PullRequest).number,
  title: (obj) => (obj.__pull as PullRequest).title,
  body: (obj) => (obj.__pull as PullRequest).body,
  state: (obj) => {
    const pull = obj.__pull as PullRequest;
    if (pull.merged) return 'MERGED';
    return pull.state === 'open' ? 'OPEN' : 'CLOSED';
  },
  merged: (obj) => (obj.__pull as PullRequest).merged,
  headRefName: (obj) => (obj.__pull as PullRequest).headRef,
  baseRefName: (obj) => (obj.__pull as PullRequest).baseRef,
  mergeable: (obj) => mergeableOf(obj.__repo as Repo, obj.__pull as PullRequest),
  mergedAt: (obj) => (obj.__pull as PullRequest).mergedAt,
  mergeCommit: (obj) => {
    const pull = obj.__pull as PullRequest;
    return pull.mergeCommitSha === null ? null : { __typename: 'Commit', __oid: pull.mergeCommitSha };
  },
  files: (obj, args) => {
    const repo = obj.__repo as Repo;
    const pull = obj.__pull as PullRequest;
    const changes = diffTrees(repo, flatOf(repo, pull.baseSha), flatOf(repo, pull.headSha));
    const first = typeof args.first === 'number' ? args.first : changes.length;
    const page = changes.slice(0, first);
    return connectionObject(
      'PullRequestChangedFileConnection',
      page.map((change) => ({
        __typename: 'PullRequestChangedFile',
        __path: change.filename,
        __additions: change.additions,
        __deletions: change.deletions,
        __changes: change.changes,
        __status: change.status === 'removed' ? 'REMOVED' : change.status === 'added' ? 'ADDED' : 'MODIFIED',
      })),
      page.map(() => null),
      changes.length > first,
    );
  },
};

RESOLVERS.PullRequestChangedFile = {
  path: (obj) => String(obj.__path ?? ''),
  filename: (obj) => String(obj.__path ?? ''),
  additions: (obj) => Number(obj.__additions ?? 0),
  deletions: (obj) => Number(obj.__deletions ?? 0),
  changes: (obj) => Number(obj.__changes ?? 0),
  status: (obj) => String(obj.__status ?? 'MODIFIED'),
};

RESOLVERS.Ref = {
  name: (obj) => String(obj.__name ?? ''),
  target: () => null,
};

RESOLVERS.Label = {
  id: (obj) => globalId('Label', String(obj.__name ?? '')),
  name: (obj) => String(obj.__name ?? ''),
  color: (obj) => String(obj.__color ?? 'ededed'),
};

RESOLVERS.IssueComment = {
  id: (obj) => {
    const comment = obj.__comment as { id: number };
    return globalId('IssueComment', String(comment.id));
  },
  body: (obj) => (obj.__comment as { body: string }).body,
  author: () => userObject(),
};

RESOLVERS.PageInfo = {
  hasNextPage: (obj) => Boolean(obj.__hasNextPage),
  hasPreviousPage: () => false,
  startCursor: (obj) => (obj.__startCursor as string | null) ?? null,
  endCursor: (obj) => (obj.__endCursor as string | null) ?? null,
};

function connectionResolvers(typeName: string): Record<string, Resolver> {
  return {
    nodes: (obj) => (obj.__nodes as GqlObject[]) ?? [],
    edges: (obj) => (obj.__edges as GqlObject[]) ?? [],
    pageInfo: (obj) => obj.__pageInfo as GqlObject,
    totalCount: (obj) => Number(obj.__totalCount ?? 0),
  };
}

RESOLVERS.IssueConnection = connectionResolvers('IssueConnection');
RESOLVERS.PullRequestConnection = connectionResolvers('PullRequestConnection');
RESOLVERS.PullRequestChangedFileConnection = connectionResolvers('PullRequestChangedFileConnection');
RESOLVERS.IssueCommentConnection = connectionResolvers('IssueCommentConnection');
RESOLVERS.LabelConnection = connectionResolvers('LabelConnection');

RESOLVERS.IssueEdge = {
  node: (obj) => obj.__node as GqlObject,
  cursor: (obj) => (obj.__cursor as string | null) ?? null,
};
RESOLVERS.PullRequestEdge = RESOLVERS.IssueEdge;
RESOLVERS.PullRequestChangedFileEdge = RESOLVERS.IssueEdge;
RESOLVERS.IssueCommentEdge = RESOLVERS.IssueEdge;
RESOLVERS.LabelEdge = RESOLVERS.IssueEdge;

RESOLVERS.CreateIssuePayload = {
  issue: (obj) => obj.__issue as GqlObject,
  clientMutationId: () => null,
};
RESOLVERS.CloseIssuePayload = {
  issue: (obj) => obj.__issue as GqlObject,
  clientMutationId: () => null,
};
RESOLVERS.CreatePullRequestPayload = {
  pullRequest: (obj) => obj.__pull as GqlObject,
  clientMutationId: () => null,
};
RESOLVERS.MergePullRequestPayload = {
  pullRequest: (obj) => obj.__pull as GqlObject,
  clientMutationId: () => null,
};
RESOLVERS.AddCommentPayload = {
  commentEdge: (obj) => obj.__commentEdge as GqlObject,
  clientMutationId: () => null,
};

RESOLVERS.__Type = {
  name: (obj) => String(obj.__typeName ?? ''),
  kind: (obj) => String(obj.__kind ?? 'OBJECT'),
  description: () => null,
  fields: (obj, args) => {
    const type = SCHEMA_TYPES[String(obj.__typeName ?? '')];
    if (type === undefined || type.kind !== 'OBJECT') return null;
    const includeDeprecated = args.includeDeprecated === true;
    void includeDeprecated;
    return (type.fields ?? []).map((name) => ({ __typename: '__Field', __fieldName: name }));
  },
  enumValues: (obj, args) => {
    const type = SCHEMA_TYPES[String(obj.__typeName ?? '')];
    if (type === undefined || type.kind !== 'ENUM') return null;
    const includeDeprecated = args.includeDeprecated === true;
    void includeDeprecated;
    return (type.enumValues ?? []).map((name) => ({ __typename: '__EnumValue', __enumName: name }));
  },
};

RESOLVERS.__Field = {
  name: (obj) => String(obj.__fieldName ?? ''),
  description: () => null,
  args: () => [],
  type: () => ({ __typename: '__Type', __typeName: 'String', __kind: 'SCALAR' }),
};

RESOLVERS.__EnumValue = {
  name: (obj) => String(obj.__enumName ?? ''),
  description: () => null,
  isDeprecated: () => false,
  deprecationReason: () => null,
};

RESOLVERS.Commit = {
  oid: (obj) => String(obj.__oid ?? ''),
};

/* ------------------------------------------------------------------ entry */

function executeOperation(
  document: Document,
  operation: Operation,
  variables: Variables,
): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const ctx: Context = { errors: [], fragments: document.fragments, variables };
  for (const definition of operation.variableDefinitions) {
    if (ctx.variables[definition.name] === undefined && definition.defaultValue !== null) {
      ctx.variables[definition.name] = resolveValue(definition.defaultValue, variables);
    }
  }
  const root: GqlObject = { __typename: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelections(root, operation.selections, ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

function executeOne(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'expected a GraphQL operation object' }] };
  }
  const record = body as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string') {
    return { data: null, errors: [{ message: 'query must be a string' }] };
  }
  const variables = (record.variables ?? {}) as Variables;
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  let document: Document;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  if (document.operations.length === 0) {
    return { data: null, errors: [{ message: 'no operation found' }] };
  }
  let operation = document.operations[0] as Operation;
  if (operationName !== null) {
    const named = document.operations.find((candidate) => candidate.name === operationName);
    if (named !== undefined) operation = named;
  }
  return executeOperation(document, operation, { ...variables });
}

export function handleGraphql(
  req: IncomingMessage,
  res: ServerResponse,
  segments: readonly string[],
  body: Buffer,
): boolean {
  if (segments.length !== 1 || segments[0] !== 'graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((item) => executeOne(item)));
    return true;
  }
  sendJson(res, 200, executeOne(parsed));
  return true;
}
