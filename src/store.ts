// The forge's whole state, in memory: repositories with their git objects and refs, issues,
// labels, comments and pull requests. Nothing here reads a clock or the network: ordering comes
// from monotonic counters, and every commit the forge itself writes uses a fixed, incrementing
// timestamp, so the same requests always build the same bytes.
//
// The token's owner is the scenario's viewer login, adaiversen: the scenario is a fixed public
// seed, so that login is the same on every trial, and the checks compare viewer.login against it.

import { buildCommit, buildTree, hashObject, parseCommit, parseTree, type GitObject, type GitObjectType, type TreeEntry } from './gitcore.ts';

/** The login the bearer token names. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;

export const FIXED_DATE = '2025-01-01T00:00:00Z';
/** The epoch every forge-written commit stamps, plus one second per commit, in creation order. */
const COMMIT_EPOCH_SEC = 1700000000;

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly userLogin: string;
  readonly seq: number;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly seq: number;
  comments: IssueComment[];
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly seq: number;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  /** refname -> commit oid. */
  readonly refs: Map<string, string>;
  /** oid -> object. */
  readonly objects: Map<string, GitObject>;
  readonly labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
  labelSeq: number;
  /** Creation order, for list ordering. */
  readonly seq: number;
}

/** The whole forge: every repository, keyed by owner/name, plus the global counters. */
export class Forge {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private repoIdSeq = 0;
  private issueIdSeq = 0;
  private pullIdSeq = 0;
  private commitClock = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    this.repoSeq += 1;
    this.repoIdSeq += 1;
    const repo: Repo = {
      id: this.repoIdSeq,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      issueSeq: 0,
      pullSeq: 0,
      commentSeq: 0,
      labelSeq: 0,
      seq: this.repoSeq,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  nextIssueId(): number {
    this.issueIdSeq += 1;
    return this.issueIdSeq;
  }

  nextPullId(): number {
    this.pullIdSeq += 1;
    return this.pullIdSeq;
  }

  /** The timestamp line for the next forge-written commit: fixed epoch, one second per commit. */
  nextCommitStamp(): string {
    this.commitClock += 1;
    return `${COMMIT_EPOCH_SEC + this.commitClock} +0000`;
  }

  /** Store an object, returning its id. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** The tip commit of a ref, or null when the ref does not exist. */
  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** Resolve a branch name, a full ref or a commit id to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
    const branch = `refs/heads/${ref}`;
    if (repo.refs.has(branch)) return repo.refs.get(branch) as string;
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const object = repo.objects.get(ref);
      if (object && object.type === 'commit') return ref;
      if (object && object.type === 'tag') return ref;
    }
    return null;
  }

  /** The commit a ref names, peeling an annotated tag to its commit. */
  resolveCommit(repo: Repo, ref: string): string | null {
    const oid = this.resolveRef(repo, ref);
    if (oid === null) return null;
    const object = repo.objects.get(oid);
    if (!object) return null;
    if (object.type === 'commit') return oid;
    return null;
  }

  /** Flatten a commit's tree to path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build a tree object from a flat path map, creating every intermediate tree. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, value] of [...flat.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, value);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /**
   * Write a commit on `branch`: replace the file map's entries, build a tree and a commit whose
   * parent is the branch tip (or none for a root commit), and move the branch. Returns the commit id.
   */
  commitFiles(
    repo: Repo,
    branch: string,
    files: Map<string, Buffer>,
    message: string,
  ): string {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? null;
    let flat = new Map<string, { oid: string; mode: string }>();
    if (tip !== null) {
      const commit = repo.objects.get(tip);
      if (commit && commit.type === 'commit') flat = this.flattenTree(repo, parseCommit(commit.data).tree);
    }
    for (const [path, content] of files) {
      const blobOid = this.putObject(repo, 'blob', content);
      flat.set(path, { oid: blobOid, mode: '100644' });
    }
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const stamp = this.nextCommitStamp();
    const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${stamp}`;
    const commitData = buildCommit({
      tree: treeOid,
      parents: tip === null ? [] : [tip],
      author: ident,
      committer: ident,
      message,
    });
    const commitOid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitOid);
    return commitOid;
  }

  /** Remove one path from a branch and commit the result; null when the path is absent. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? null;
    if (tip === null) return null;
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return null;
    const flat = this.flattenTree(repo, parseCommit(commit.data).tree);
    if (!flat.has(path)) return null;
    flat.delete(path);
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const stamp = this.nextCommitStamp();
    const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${stamp}`;
    const commitData = buildCommit({
      tree: treeOid,
      parents: [tip],
      author: ident,
      committer: ident,
      message,
    });
    const commitOid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitOid);
    return commitOid;
  }

  /** The blob id and bytes of a path at a commit, or null when the path is not a file there. */
  fileAt(repo: Repo, commitOid: string, path: string): { oid: string; data: Buffer } | null {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    const flat = this.flattenTree(repo, parseCommit(commit.data).tree);
    const entry = flat.get(path);
    if (!entry) return null;
    const blob = repo.objects.get(entry.oid);
    if (!blob || blob.type !== 'blob') return null;
    return { oid: entry.oid, data: blob.data };
  }

  /** The tree entries directly under a directory path at a commit ('' is the root). */
  dirAt(repo: Repo, commitOid: string, dir: string): { name: string; path: string; oid: string; mode: string }[] | null {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    let treeOid = parseCommit(commit.data).tree;
    if (dir !== '') {
      const walk = (oid: string, parts: string[]): string | null => {
        if (parts.length === 0) return oid;
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'tree') return null;
        for (const entry of parseTree(object.data)) {
          if (entry.name === parts[0] && entry.mode === '40000') return walk(entry.oid, parts.slice(1));
        }
        return null;
      };
      const found = walk(treeOid, dir.split('/'));
      if (found === null) return null;
      treeOid = found;
    }
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return null;
    return parseTree(object.data).map((entry) => ({
      name: entry.name,
      path: dir === '' ? entry.name : `${dir}/${entry.name}`,
      oid: entry.oid,
      mode: entry.mode,
    }));
  }
}

/** One shared forge for the process. */
export const forge = new Forge();
