// Git smart HTTP: info/refs (v0 and v2 advertisements), git-upload-pack (v2 ls-refs/fetch and
// the v0 fetch) and git-receive-pack (command list, pack unpack, per-ref report-status). The
// object selection for a fetch is: the depth-limited reachable set from the wants, minus the
// full reachable set from the haves; shallow boundaries are the included commits whose parents
// were cut off by the depth.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  collectReachable,
  decodePktLines,
  decodePktLinesUntilFlush,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  pktLine,
  pktLines,
  readPack,
  writePack,
  type GitObject,
} from './gitcore.ts';
import { forge, VIEWER_LOGIN, type Repo } from './store.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const JSON_TYPE = 'application/json; charset=utf-8';

const V2_CAPABILITIES: readonly string[] = [
  'ls-refs=unborn',
  'fetch=shallow filter thin-pack ofs-delta no-progress',
  'agent',
  'object-format=sha1',
];
const V0_UPLOAD_CAPABILITIES = 'side-band-64k thin-pack ofs-delta multi_ack_detailed agent shallow';
const V0_RECEIVE_CAPABILITIES = 'report-status side-band-64k delete-refs ofs-delta agent';

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  sendBuffer(res, status, JSON_TYPE, Buffer.from(text, 'utf8'));
}

interface RefLine {
  readonly oid: string;
  readonly name: string;
  readonly peeled?: string;
}

/** Every ref the repo advertises, HEAD first, then refs sorted by name. */
function advertisedRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const mainTip = repo.refs.get('refs/heads/main') ?? null;
  if (mainTip !== null) lines.push({ oid: mainTip, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const peeled = peelTag(repo, oid);
      if (peeled !== null) (entry as { peeled?: string }).peeled = peeled;
    }
    lines.push(entry);
  }
  return lines;
}

/** Peel an annotated tag (through a tag chain) to its commit, or null. */
function peelTag(repo: Repo, tagOid: string): string | null {
  let current = tagOid;
  for (let i = 0; i < 10; i += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPABILITIES : V0_RECEIVE_CAPABILITIES;
  const mainTip = repo.refs.get('refs/heads/main') ?? null;
  const symref = mainTip !== null ? ` symref=HEAD:refs/heads/main` : '';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}${symref}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}${symref}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH, pktLine('version 2\n')];
  for (const cap of V2_CAPABILITIES) parts.push(pktLine(`${cap}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/**
 * What the client already holds, from its haves: the reachable set from each have, but never
 * past a shallow boundary — a boundary commit is held, its parents are not. A plain
 * collectReachable would claim the client holds the whole history behind a shallow tip.
 */
function collectHaveSet(repo: Repo, haves: readonly string[], oldShallow: readonly string[]): Set<string> {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const haveSet = new Set<string>();
  const seen = new Set<string>();
  const queue = [...haves];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      haveSet.add(oid);
      const peeled = peelTag(repo, oid);
      if (peeled !== null) queue.push(peeled);
      continue;
    }
    if (object.type !== 'commit') {
      haveSet.add(oid);
      continue;
    }
    haveSet.add(oid);
    const treeOid = parseCommit(object.data).tree;
    for (const reachable of collectReachable([treeOid], lookup, { allowMissing: true })) haveSet.add(reachable);
    if (oldShallow.includes(oid)) continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return haveSet;
}

/** Depth-limited reachable set from the wants, minus what the haves already hold. */
function selectFetchObjects(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | undefined,
  oldShallow: readonly string[],
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const haveSet = collectHaveSet(repo, haves, oldShallow);
  // Walk commits by distance from the wants; a commit at distance d is included when d < depth
  // (or always, when no depth was asked for). Every included commit brings its whole tree.
  const commitDistance = new Map<string, number>();
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const want of wants) {
    const object = lookup(want);
    if (!object) continue;
    if (object.type === 'tag') {
      const peeled = peelTag(repo, want);
      if (peeled !== null) queue.push({ oid: peeled, dist: 0 });
      commitDistance.set(want, 0);
    } else if (object.type === 'commit') {
      queue.push({ oid: want, dist: 0 });
    }
  }
  const includedCommits = new Set<string>();
  const boundary = new Set<string>();
  while (queue.length > 0) {
    const { oid, dist } = queue.shift() as { oid: string; dist: number };
    const known = commitDistance.get(oid);
    if (known !== undefined && known <= dist) continue;
    commitDistance.set(oid, dist);
    if (depth !== undefined && dist >= depth) {
      boundary.add(oid);
      continue;
    }
    includedCommits.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, dist: dist + 1 });
  }
  // A commit is shallow when it is included but one of its parents is not.
  const shallow: string[] = [];
  for (const oid of includedCommits) {
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.some((parent) => !includedCommits.has(parent))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const old of oldShallow) {
    if (includedCommits.has(old) && !shallow.includes(old)) unshallow.push(old);
  }
  const wanted = new Set<string>();
  for (const want of wants) {
    const object = lookup(want);
    if (object && object.type === 'tag') wanted.add(want);
  }
  // Only the depth-limited commits and their tree closures: expanding a commit's parents here
  // would re-deliver the history the depth was asked to cut off.
  for (const oid of includedCommits) {
    wanted.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const treeOid = parseCommit(object.data).tree;
    for (const reachable of collectReachable([treeOid], lookup, { allowMissing: true })) wanted.add(reachable);
  }
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (haveSet.has(oid)) continue;
    const object = lookup(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow, unshallow };
}

/** Chunk a pack into sideband packets (band 1), each a pkt-line of at most ~32 KiB of pack data. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const piece = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

/** Parse a v2 fetch/ls-refs request body into its command and arguments. */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    args.push(line);
  }
  return { command, args };
}

function parseFetchArgs(args: readonly string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) out.depth = n;
    }
  }
  return out;
}

/**
 * Build the v2 fetch response, framed the way git's own upload-pack frames it: sections are
 * separated by a delim packet (0001) and only the packfile section ends with a flush. The
 * acknowledgments section appears whenever the client sent haves — a client that sent haves
 * expects it — and it carries a `ready` line after the ACK/NAK lines. A flush after the
 * acknowledgments makes a real client expect the response to be over, so it must be a delim.
 */
function v2FetchResponse(repo: Repo, fetchArgs: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = selectFetchObjects(repo, fetchArgs.wants, fetchArgs.haves, fetchArgs.depth, fetchArgs.shallow);
  const pack = writePack(objects.map((object) => ({ type: object.type, data: object.data })));
  const parts: Buffer[] = [];
  if (fetchArgs.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const matched = fetchArgs.haves.filter((have) => repo.objects.has(have));
    if (matched.length > 0) {
      for (const have of matched) parts.push(pktLine(`ACK ${have}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  if (fetchArgs.depth !== undefined || shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Build the v0 fetch response: NAK/ACK and shallow lines, then the sideband pack. */
function v0FetchResponse(repo: Repo, fetchArgs: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = selectFetchObjects(repo, fetchArgs.wants, fetchArgs.haves, fetchArgs.depth, fetchArgs.shallow);
  const pack = writePack(objects.map((object) => ({ type: object.type, data: object.data })));
  const parts: Buffer[] = [];
  const matched = fetchArgs.haves.filter((have) => repo.objects.has(have));
  if (matched.length > 0) {
    for (const have of matched) parts.push(pktLine(`ACK ${have}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Parse a v0 upload-pack request: wants (with capabilities on the first line), then haves. */
function parseV0Fetch(body: Buffer): FetchArgs {
  const packets = decodePktLines(body);
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const nul = rest.indexOf('\0');
      out.wants.push((nul >= 0 ? rest.slice(0, nul) : rest).trim());
    } else if (line.startsWith('have ')) out.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) out.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) out.depth = n;
    }
    void section;
  }
  return out;
}

function lsRefsV2Response(repo: Repo, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const mainTip = repo.refs.get('refs/heads/main') ?? null;
  if (keep('HEAD')) {
    if (mainTip !== null) {
      parts.push(pktLine(`${mainTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    } else {
      parts.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') {
        const peeled = peelTag(repo, oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** Parse a receive-pack body: the command list up to the first flush, then the pack bytes. */
function parsePushBody(body: Buffer): { commands: PushCommand[]; sideband: boolean; pack: Buffer } {
  const { packets, nextOffset } = decodePktLinesUntilFlush(body);
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    if (nul >= 0) {
      const caps = line.slice(nul + 1).split(' ');
      if (caps.includes('side-band-64k')) sideband = true;
    }
    const parts = head.split(' ');
    if (parts.length < 3) throw new Error('bad push command line');
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) throw new Error('bad push command');
    commands.push({ oldOid, newOid, ref });
  }
  return { commands, sideband, pack: body.subarray(nextOffset) };
}

function pushReport(repo: Repo, commands: readonly PushCommand[], pack: Buffer, sideband: boolean): Buffer {
  const lines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      // Thin packs delta against objects the server already holds: resolve those bases
      // from the repository, not from the pack alone.
      const read = readPack(pack, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  if (unpackOk) {
    lines.push('unpack ok');
  } else {
    lines.push(`unpack ${unpackDetail}`);
  }
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? null;
    if (!unpackOk) {
      lines.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (current === null) {
        lines.push(`ng ${command.ref} no such ref`);
      } else if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
        lines.push(`ng ${command.ref} non-fast-forward`);
      } else {
        repo.refs.delete(command.ref);
        lines.push(`ok ${command.ref}`);
      }
      continue;
    }
    const object = repo.objects.get(command.newOid);
    if (!object || (object.type !== 'commit' && object.type !== 'tag')) {
      lines.push(`ng ${command.ref} missing object`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== null) {
        lines.push(`ng ${command.ref} already exists`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        lines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (current === null || current !== command.oldOid) {
      lines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    if (object.type === 'commit' && !isAncestor(command.oldOid, command.newOid, (oid) => repo.objects.get(oid))) {
      lines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    lines.push(`ok ${command.ref}`);
  }
  const report = pktLines(lines.map((line) => `${line}\n`));
  if (!sideband) return Buffer.concat([report, PKT_FLUSH]);
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < report.length; offset += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, Math.min(report.length, offset + CHUNK))])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Look a repository up by owner/name; the token owns only the viewer's repositories. */
function lookupRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return forge.getRepo(owner, name) ?? null;
}

/** The git path of a request: /<owner>/<repo>.git/<service...> split into segments. */
export function gitSegments(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment !== '');
}

/**
 * Handle a git smart-HTTP request. Returns true when it answered (including its 404s); false
 * when the path is not a git path at all.
 */
export function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  segments: readonly string[],
  query: URLSearchParams,
  body: Buffer,
): boolean {
  if (segments.length < 2) return false;
  const repoSegment = segments[1] as string;
  if (!repoSegment.endsWith('.git')) return false;
  const owner = decodeURIComponent(segments[0] as string);
  const name = decodeURIComponent(repoSegment.slice(0, -4));
  const tail = segments.slice(2);
  const method = req.method ?? 'GET';

  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 400, { message: 'unknown service' });
      return true;
    }
    const repo = lookupRepo(owner, name);
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
    if (service === 'git-receive-pack') {
      sendBuffer(res, 200, RECEIVE_AD, v0Advertisement(repo, service));
    } else if (wantsV2) {
      sendBuffer(res, 200, UPLOAD_AD, v2Advertisement());
    } else {
      sendBuffer(res, 200, UPLOAD_AD, v0Advertisement(repo, service));
    }
    return true;
  }

  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    const repo = lookupRepo(owner, name);
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    try {
      if (wantsV2) {
        const { command, args } = parseV2Request(body);
        if (command === 'ls-refs') {
          sendBuffer(res, 200, UPLOAD_RESULT, lsRefsV2Response(repo, args));
        } else if (command === 'fetch') {
          sendBuffer(res, 200, UPLOAD_RESULT, v2FetchResponse(repo, parseFetchArgs(args)));
        } else {
          sendJson(res, 400, { message: `unknown command ${command}` });
        }
      } else {
        sendBuffer(res, 200, UPLOAD_RESULT, v0FetchResponse(repo, parseV0Fetch(body)));
      }
    } catch (err) {
      sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad request' });
    }
    return true;
  }

  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    const repo = lookupRepo(owner, name);
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    try {
      const { commands, sideband, pack } = parsePushBody(body);
      if (commands.length === 0) {
        sendJson(res, 400, { message: 'no push commands' });
        return true;
      }
      sendBuffer(res, 200, RECEIVE_RESULT, pushReport(repo, commands, pack, sideband));
    } catch (err) {
      sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad request' });
    }
    return true;
  }

  return false;
}
