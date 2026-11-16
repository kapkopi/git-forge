// The git object model, packfile codec, pkt-line codec, and graph walks shared by every surface.
// Everything here is pure bytes-and-hashes: no HTTP, no store, no clock. The object formats match
// git exactly (SHA-1 over "<type> <size>\0" + bytes), so objects created here and objects pushed
// over smart HTTP are interchangeable in one store.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;

const HEX40_RE = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40_RE.test(value);
}

/** Normalize an oid for store lookup: lowercase hex, or null when it is not a 40-hex id. */
export function normOid(value: string): string | null {
  const lower = value.toLowerCase();
  return HEX40_RE.test(lower) ? lower : null;
}

/** git's object id: SHA-1 over "<type> <size>\0" + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

// --------------------------------------------------------------------------- trees

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > data.length) throw new Error('tree entry has a truncated object id');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- commits and tags

/** Parse a commit object. Header lines other than tree/parent/author/committer are ignored. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

/**
 * Build a commit object's bytes. The author/committer lines are full
 * "Name <email> <epoch> <tz>" lines and the message is stored verbatim.
 */
export function buildCommit(tree: string, parents: readonly string[], authorLine: string, committerLine: string, message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${authorLine}`, `committer ${committerLine}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error('tag has a bad type header');
  }
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Follow annotated tags to the object they ultimately point at (a commit for the usual case). */
export function peelObject(lookup: (oid: string) => GitObject | undefined, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const object = lookup(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
}

// --------------------------------------------------------------------------- deltas

/** Apply a git delta (the copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

// --------------------------------------------------------------------------- packfiles

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Inflate one zlib stream starting at `offset`; returns its bytes and the offset past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

/**
 * Read a packfile (version 2/3), resolving OFS_DELTA and REF_DELTA entries. The trailer checksum
 * is verified. REF_DELTA bases outside the pack resolve through `resolveBase` when given.
 * Returns the objects keyed by their recomputed ids. Throws on any corruption.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

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
    if (offset >= trailerStart) throw new Error('pack entry header is truncated');
    let byte = pack[offset];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (offset >= trailerStart) throw new Error('ofs-delta has no base offset');
      byte = pack[offset];
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        if (offset >= trailerStart) throw new Error('ofs-delta base offset is truncated');
        byte = pack[offset++];
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      if (value <= 0 || value > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch after inflate');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (external === undefined) throw new Error('ref-delta base is neither in the pack nor on the server');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
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
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
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

/** A pack entry's bytes, keyed by the object id: content-addressed, so an entry never goes stale. */
const PACK_ENTRY_CACHE = new Map<string, Buffer>();
const PACK_ENTRY_CACHE_MAX = 20000;

/** Build a packfile version 2 from plain objects (no deltas), each exactly once, with a trailer. */
export function writePack(objects: Iterable<{ oid: string; type: GitObjectType; data: Buffer }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    let entry = PACK_ENTRY_CACHE.get(object.oid);
    if (entry === undefined) {
      entry = Buffer.concat([writePackObjectHeader(object.type, object.data.length), deflateSync(object.data)]);
      if (PACK_ENTRY_CACHE.size < PACK_ENTRY_CACHE_MAX) PACK_ENTRY_CACHE.set(object.oid, entry);
    }
    parts.push(entry);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// --------------------------------------------------------------------------- pkt-line

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_LINE_MAX) throw new Error('pkt-line payload is over the maximum');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktItem = string | Buffer | 'flush' | 'delim';

/** Encode a mixed sequence; 'flush'/'delim' are the control packets. */
export function pktLines(items: readonly PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type DecodedPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4_RE = /^[0-9a-fA-F]{4}$/;

/**
 * Decode pkt-lines from the start of `buf` until the first flush packet (included) or the end of
 * the buffer. Returns the packets and the number of bytes consumed; anything past the flush is the
 * caller's (a receive-pack's raw pack bytes). Throws on a malformed or truncated framing.
 */
export function decodePktLinesUpToFlush(buf: Buffer): { packets: DecodedPacket[]; consumed: number } {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  for (;;) {
    if (offset >= buf.length) return { packets, consumed: offset };
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4_RE.test(header)) throw new Error('invalid pkt-line length');
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      return { packets, consumed: offset + 4 };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new Error('invalid pkt-line length');
    if (offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
}

/** Decode every pkt-line in a complete buffer (a v2 command or a v0 fetch request). */
export function decodeAllPktLines(buf: Buffer): DecodedPacket[] {
  const packets: DecodedPacket[] = [];
  let rest = buf;
  for (;;) {
    const { packets: chunk, consumed } = decodePktLinesUpToFlush(rest);
    packets.push(...chunk);
    rest = rest.subarray(consumed);
    if (rest.length === 0) return packets;
    // A second section follows (v0 fetch: wants, flush, haves, flush). Keep decoding.
    if (chunk.length === 0) throw new Error('pkt-line decode made no progress');
  }
}

// --------------------------------------------------------------------------- graph walks

export interface Reachability {
  /** Every object reachable within the limits (commits, trees, blobs, tags). */
  readonly objects: Set<string>;
  /** Commits at the depth cutoff (their parents were excluded): the shallow boundary. */
  readonly boundary: Set<string>;
}

/**
 * Walk from `roots` over the object graph. Commits consume depth (a commit at distance d is kept
 * when d < maxDepth); trees, blobs and tag dereferences are free. Commits in `shallowCut` are kept
 * with their trees but their parents are never followed (the client's shallow boundary when
 * computing what it already holds). Missing objects are skipped when `allowMissing` is set.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  options: { maxDepth?: number; shallowCut?: ReadonlySet<string>; allowMissing?: boolean } = {},
): Reachability {
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const shallowCut = options.shallowCut;
  const objects = new Set<string>();
  const boundary = new Set<string>();
  const seen = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const root of roots) {
    if (isOid(root) && !seen.has(root)) {
      seen.add(root);
      queue.push({ oid: root, depth: 0 });
    }
  }
  let head = 0;
  while (head < queue.length) {
    const { oid, depth } = queue[head++];
    const object = lookup(oid);
    if (object === undefined) {
      if (options.allowMissing === true) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    objects.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (depth < maxDepth) {
        if (!seen.has(commit.tree)) {
          seen.add(commit.tree);
          queue.push({ oid: commit.tree, depth });
        }
      }
      const cut = shallowCut !== undefined && shallowCut.has(oid);
      if (depth + 1 >= maxDepth || cut) {
        if (depth + 1 >= maxDepth && maxDepth !== Number.POSITIVE_INFINITY) boundary.add(oid);
      } else {
        for (const parent of commit.parents) {
          if (!seen.has(parent)) {
            seen.add(parent);
            queue.push({ oid: parent, depth: depth + 1 });
          }
        }
      }
      // A commit at the cutoff still keeps its tree even when its parents are cut: the tree was
      // queued above whenever depth < maxDepth, which holds for every kept commit.
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (!seen.has(target)) {
        seen.add(target);
        queue.push({ oid: target, depth });
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        if (!seen.has(entry.oid)) {
          seen.add(entry.oid);
          queue.push({ oid: entry.oid, depth });
        }
      }
    }
  }
  return { objects, boundary };
}

/** True when `ancestor` equals `oid` or is reachable from it by following parents. */
export function isAncestor(lookup: (oid: string) => GitObject | undefined, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const queue = [oid];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = lookup(current);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/**
 * The merge-base of two tips: the first commit reachable from `b` that is also reachable from `a`
 * (breadth-first from `b`, so the nearest common ancestor). Null for unrelated histories.
 */
export function mergeBase(lookup: (oid: string) => GitObject | undefined, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (ancestorsA.has(current)) continue;
    ancestorsA.add(current);
    const object = lookup(current);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  const seen = new Set<string>();
  const queue = [b];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    if (seen.has(current)) continue;
    seen.add(current);
    if (ancestorsA.has(current)) return current;
    const object = lookup(current);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

/** The commit history from a tip, newest first (first-parent order with merge parents queued). */
export function commitHistory(lookup: (oid: string) => GitObject | undefined, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = lookup(current);
    if (object === undefined || object.type !== 'commit') continue;
    order.push(current);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return order;
}

// --------------------------------------------------------------------------- trees as file maps

export interface FlatFile {
  readonly oid: string;
  readonly mode: string;
}

/** Flatten a tree (recursively) into path -> file. Directories vanish; gitlinks are skipped. */
export function flattenTree(
  lookup: (oid: string) => GitObject | undefined,
  treeOid: string,
  prefix = '',
  out: Map<string, FlatFile> = new Map(),
): Map<string, FlatFile> {
  const object = lookup(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(lookup, entry.oid, path, out);
    else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/**
 * Build nested tree objects for a file map, storing each tree with `put`, and return the root
 * tree's id. An empty map builds the empty tree.
 */
export function buildTreeFromMap(files: ReadonlyMap<string, FlatFile>, put: (type: GitObjectType, data: Buffer) => string): string {
  interface Node {
    files: Map<string, FlatFile>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, file] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1]!, file);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

export type DiffStatus = 'added' | 'removed' | 'modified';

export interface FileDiff {
  readonly path: string;
  readonly status: DiffStatus;
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

/** Compare two flattened trees: every path whose blob differs, added, or removed. */
export function diffFileMaps(base: ReadonlyMap<string, FlatFile>, head: ReadonlyMap<string, FlatFile>): FileDiff[] {
  const diffs: FileDiff[] = [];
  for (const [path, file] of head) {
    const old = base.get(path);
    if (old === undefined) diffs.push({ path, status: 'added', oldOid: null, newOid: file.oid });
    else if (old.oid !== file.oid) diffs.push({ path, status: 'modified', oldOid: old.oid, newOid: file.oid });
  }
  for (const [path, file] of base) {
    if (!head.has(path)) diffs.push({ path, status: 'removed', oldOid: file.oid, newOid: null });
  }
  diffs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return diffs;
}

/**
 * Three-way merge at file granularity: a path changed on both sides since the base, to different
 * results, conflicts. Returns the merged file map, or null with the conflicting paths.
 */
export function threeWayMerge(
  base: ReadonlyMap<string, FlatFile>,
  ours: ReadonlyMap<string, FlatFile>,
  theirs: ReadonlyMap<string, FlatFile>,
): { merged: Map<string, FlatFile>; conflicts: string[] } {
  const merged = new Map<string, FlatFile>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const bOid = b?.oid ?? null;
    const oOid = o?.oid ?? null;
    const tOid = t?.oid ?? null;
    if (oOid === tOid) {
      if (o !== undefined) merged.set(path, o);
    } else if (oOid === bOid) {
      if (t !== undefined) merged.set(path, t);
    } else if (tOid === bOid) {
      if (o !== undefined) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  conflicts.sort();
  return { merged, conflicts };
}

// --------------------------------------------------------------------------- ref names

/** git's ref-name rules, the subset that matters for pushes (the client validates the rest). */
export function isValidRefName(name: string): boolean {
  if (name === '' || name.length > 200) return false;
  if (!name.startsWith('refs/')) return false;
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  if (name.includes('..') || name.includes('//')) return false;
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
    const ch = name[i]!;
    if (ch === '~' || ch === '^' || ch === ':' || ch === '?' || ch === '*' || ch === '[' || ch === '\\') return false;
  }
  if (name.includes('@{')) return false;
  const parts = name.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.startsWith('.'))) return false;
  return true;
}
