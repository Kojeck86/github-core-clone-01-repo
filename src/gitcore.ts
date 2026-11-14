// Git's on-disk shapes, written from the protocol's own rules: pkt-line framing, the SHA-1 object
// model (blob/tree/commit/tag), and packfiles (plain objects plus OFS/REF deltas). No git binary is
// involved anywhere: hashing is node:crypto, compression is node:zlib.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const PKT_LINE_MAX = 65520;

/** The four object types a pack or a loose object can hold. */
export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 over "<type> <size>\0" + data: the object's id. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** Build a git object header plus payload, as stored. */
export function objectBytes(type: GitObjectType, data: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'ascii'), Buffer.from(data)]);
}

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktLine {
  readonly kind: PktKind;
  /** The payload for a data packet (without its length prefix); empty otherwise. */
  readonly payload: Buffer;
  /** The packet's full wire length, length prefix included. */
  readonly rawLength: number;
}

/** Encode one data packet: a 4-hex length prefix plus the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Encode several lines (strings or Buffers) plus an optional flush at the end. */
export function pktLines(lines: readonly (Buffer | string)[], flush = true): Buffer {
  const parts: Buffer[] = lines.map((line) => pktLine(line));
  if (flush) parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/**
 * Decode a whole buffer of pkt-lines. Throws on a bad length prefix or a truncated packet, so a
 * malformed request fails as a parse error instead of corrupting state.
 */
/**
 * Decode pkt-lines from the front of a buffer until the first flush packet (inclusive) and
 * stop there: a receive-pack body carries a packfile after the flush, and pack bytes are not
 * pkt-lines. Returns the packets and the offset where the trailing bytes begin.
 */
export function decodePktLinesUntilFlush(buffer: Buffer): { packets: PktLine[]; nextOffset: number } {
  const packets: PktLine[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line truncated at the length prefix');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0), rawLength: 4 });
      return { packets, nextOffset: offset + 4 };
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0), rawLength: 4 });
      offset += 4;
      continue;
    }
    if (head === '0002') {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0), rawLength: 4 });
      offset += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || len > PKT_LINE_MAX) {
      throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    }
    if (offset + len > buffer.length) throw new Error('pkt-line truncated in its payload');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + len), rawLength: len });
    offset += len;
  }
  return { packets, nextOffset: offset };
}

export function decodePktLines(buffer: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line truncated at the length prefix');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      out.push({ kind: 'flush', payload: Buffer.alloc(0), rawLength: 4 });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      out.push({ kind: 'delim', payload: Buffer.alloc(0), rawLength: 4 });
      offset += 4;
      continue;
    }
    if (head === '0002') {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0), rawLength: 4 });
      offset += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || len > PKT_LINE_MAX) {
      throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    }
    if (offset + len > buffer.length) throw new Error('pkt-line truncated in its payload');
    out.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + len), rawLength: len });
    offset += len;
  }
  return out;
}

/** The data-packet payloads of a buffer, in order, as UTF-8 strings. */
export function pktDataLines(buffer: Buffer): string[] {
  const lines: string[] = [];
  for (const packet of decodePktLines(buffer)) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// -------------------------------------------------------------------------------------------
// objects: build and parse
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Git's tree sort: entries compare by name, directories as if the name ended with '/'. */
export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  const key = (entry: TreeEntry): string => (entry.mode === '40000' ? `${entry.name}/` : entry.name);
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Serialize a tree object from its entries (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry has no name or oid');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface TagInfo {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse a commit object: headers up to the first blank line, the rest is the message verbatim. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Serialize a commit object. The message is kept exactly as given. */
export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${info.message}`, 'utf8');
}

/** Serialize an annotated tag object. */
export function buildTag(info: {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}): Buffer {
  const lines = [`object ${info.object}`, `type ${info.type}`, `tag ${info.tag}`, `tagger ${info.tagger}`, ''];
  return Buffer.from(`${lines.join('\n')}\n${info.message}`, 'utf8');
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

function readPackVarint(buffer: Buffer, offset: number): { size: number; typeCode: number; next: number } {
  let byte = buffer[offset] ?? 0;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let pos = offset + 1;
  while (byte & 0x80) {
    byte = buffer[pos] ?? 0;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    pos += 1;
  }
  return { size, typeCode, next: pos };
}

function readOfsDeltaBase(buffer: Buffer, offset: number): { baseOffset: number; next: number } {
  let byte = buffer[offset] ?? 0;
  let base = byte & 0x7f;
  let pos = offset + 1;
  while (byte & 0x80) {
    byte = buffer[pos] ?? 0;
    base = ((base + 1) << 7) | (byte & 0x7f);
    pos += 1;
  }
  return { baseOffset: base, next: pos };
}

function readDeltaVarint(data: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const byte = data[pos] ?? 0;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: pos };
}

/** Apply a git delta stream to its base bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const sourceSize = readDeltaVarint(delta, 0);
  if (sourceSize.value !== base.length) throw new Error('delta base size does not match the base object');
  const targetSize = readDeltaVarint(delta, sourceSize.next);
  const parts: Buffer[] = [];
  let total = 0;
  let pos = targetSize.next;
  while (pos < delta.length) {
    const op = delta[pos] ?? 0;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          offset |= (delta[pos] ?? 0) << (bit * 8);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          size |= (delta[pos] ?? 0) << (bit * 8);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past the base object');
      parts.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op > 0) {
      if (pos + op > delta.length) throw new Error('delta insert runs past the delta stream');
      parts.push(delta.subarray(pos, pos + op));
      total += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (total !== targetSize.value) throw new Error('delta result size does not match its header');
  return Buffer.concat(parts, total);
}

/**
 * Inflate one deflate stream out of `buffer` starting at `offset`, and say exactly how many bytes
 * the stream consumed. Node's inflateSync ignores trailing bytes and throws on a truncated stream,
 * so a binary search over the stream's end finds it: a small first guess, doubling while truncated,
 * then a search between the last failure and the first success.
 */
function inflateAt(buffer: Buffer, offset: number, declaredSize: number): { data: Buffer; next: number } {
  const remaining = buffer.length - offset;
  let lo = 0;
  let hi = -1;
  let guess = Math.min(remaining, Math.max(16, declaredSize + 64));
  for (;;) {
    try {
      const data = inflateSync(buffer.subarray(offset, offset + guess));
      if (data.length !== declaredSize) throw new Error(`pack entry declares ${declaredSize} bytes but inflated to ${data.length}`);
      hi = guess;
      break;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('pack entry declares')) throw err;
      lo = guess;
      if (guess >= remaining) throw new Error('deflate stream runs past the pack');
      guess = Math.min(remaining, guess * 2);
    }
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    try {
      const data = inflateSync(buffer.subarray(offset, offset + mid));
      if (data.length !== declaredSize) throw new Error(`pack entry declares ${declaredSize} bytes but inflated to ${data.length}`);
      hi = mid;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('pack entry declares')) throw err;
      lo = mid;
    }
  }
  const data = inflateSync(buffer.subarray(offset, offset + hi));
  return { data, next: offset + hi };
}

export interface PackReadResult {
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
}

/**
 * Read a packfile (version 2 or 3), resolve OFS/REF deltas, recompute every id and verify the
 * trailer. A thin pack's missing REF_DELTA base is supplied through `resolveBase`.
 */
export function readPack(pack: Uint8Array, options: { resolveBase?: (oid: string) => GitObject | undefined } = {}): PackReadResult {
  const buffer = Buffer.from(pack);
  if (buffer.length < 32) throw new Error('pack is too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer does not match its bytes');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(buffer, offset);
    offset = header.next;
    const typeCode = header.typeCode;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset, header.size);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  let deltaCount = 0;
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid ?? '';
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is not in the pack`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile of plain objects (no deltas): header, one entry per object, SHA-1 trailer. */
export function writePack(objects: Iterable<{ type: GitObjectType; data: Uint8Array }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.from(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** The objects reachable from `tips`, walking commits, trees and tags; throws on a missing object. */
export function collectReachable(
  tips: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`missing object ${oid}`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      if (isObjectId(info.tree)) stack.push(info.tree);
      for (const parent of info.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        stack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      const info = parseTag(object.data);
      if (isObjectId(info.object)) stack.push(info.object);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or equal to it). */
export function isAncestor(ancestor: string, tip: string, lookup: (oid: string) => GitObject | undefined): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The newest common ancestor of two commits, or null when their histories never meet. */
export function mergeBase(
  a: string,
  b: string,
  lookup: (oid: string) => GitObject | undefined,
): string | null {
  const ancestorsA = new Set<string>();
  const stackA: string[] = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stackA.push(parent);
  }
  const stackB: string[] = [b];
  const seenB = new Set<string>();
  while (stackB.length > 0) {
    const oid = stackB.pop() as string;
    if (ancestorsA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stackB.push(parent);
  }
  return null;
}
