// Git smart HTTP: upload-pack (protocol v2 and v0) and receive-pack (v0), served from the same
// object store REST uses. Pushed bytes are stored verbatim; packs the server writes carry plain
// entries only, each object exactly once. The fetch set is exactly W minus H (wants minus haves,
// shallow-aware), which the incremental, shallow and nothing-new checks assert object for object.

import {
  ZERO_OID,
  collectReachable,
  decodeAllPktLines,
  decodePktLinesUpToFlush,
  isAncestor,
  isOid,
  isValidRefName,
  peelObject,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  writePack,
  type GitObjectType,
} from './gitstore.ts';
import {
  defaultTip,
  getObject,
  lookupOf,
  type Forge,
  type Repo,
} from './store.ts';

export interface GitContext {
  forge: Forge;
  method: string;
  /** The full pathname, e.g. "/adaiversen/amber-thistle.git/info/refs". */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  authorized: boolean;
}

export interface GitResult {
  status: number;
  headers?: Record<string, string>;
  body: Buffer;
}

const AGENT = 'agent=github-core-clone/1.0';
const SIDEBAND_CHUNK = 60000;

function textResult(status: number, text: string): GitResult {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from(text, 'utf8') };
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const heads: Array<{ name: string; oid: string }> = [];
  const tags: Array<{ name: string; oid: string }> = [];
  const other: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) {
    const entry = { name, oid };
    if (name.startsWith('refs/heads/')) heads.push(entry);
    else if (name.startsWith('refs/tags/')) tags.push(entry);
    else other.push(entry);
  }
  const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  heads.sort(byName);
  tags.sort(byName);
  other.sort(byName);
  return [...heads, ...tags, ...other];
}

function oneLine(message: string): string {
  return message.replace(/[\r\n]+/g, ' ').slice(0, 200);
}

/** One sideband packet: a band byte + data, inside a pkt-line. */
function sidebandPacket(band: number, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Sideband packets for a payload, chunked so no pkt-line exceeds the limit. */
function sidebandData(band: number, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    parts.push(sidebandPacket(band, data.subarray(offset, offset + SIDEBAND_CHUNK)));
  }
  if (data.length === 0) parts.push(sidebandPacket(band, Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- advertisement

/** The v0 ref section: HEAD, sorted refs, peeled lines, caps on the first line, then a flush. */
function v0RefSection(repo: Repo, caps: string): Buffer {
  const lines: Buffer[] = [];
  let first = true;
  const emit = (oid: string, name: string, peeled?: string): void => {
    let line = `${oid} ${name}`;
    if (first) {
      line += `\u0000${caps}`;
      first = false;
    }
    lines.push(pktLine(`${line}\n`));
    if (peeled !== undefined) lines.push(pktLine(`${peeled} ${name}^{}\n`));
  };
  const lookup = lookupOf(repo);
  const head = defaultTip(repo);
  if (head !== undefined) emit(head, 'HEAD');
  for (const ref of sortedRefs(repo)) {
    const object = getObject(repo, ref.oid);
    const peeled = object !== undefined && object.type === 'tag' ? peelObject(lookup, ref.oid) : undefined;
    emit(ref.oid, ref.name, peeled);
  }
  if (lines.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

function handleInfoRefs(ctx: GitContext, repo: Repo, service: string): GitResult {
  const contentType = `application/x-${service}-advertisement`;
  const headers = { 'content-type': contentType, 'cache-control': 'no-cache' };
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const gitProtocol = ctx.headers['git-protocol'];
  const wantsV2 = service === 'git-upload-pack' && gitProtocol === 'version=2';
  if (wantsV2) {
    // v2: no service preamble — "version 2", then capability lines, then a flush.
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      pktLine(`${AGENT}\n`),
      pktFlush(),
    ]);
    return { status: 200, headers, body };
  }
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k shallow ${symref} ${AGENT}`
      : `report-status side-band-64k delete-refs ${symref} ${AGENT}`;
  const body = Buffer.concat([pktLine(`# service=${service}\n`), pktFlush(), v0RefSection(repo, caps)]);
  return { status: 200, headers, body };
}

// --------------------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

interface FetchResult {
  objects: Array<{ oid: string; type: GitObjectType; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

function computeFetch(repo: Repo, request: FetchRequest): FetchResult {
  const lookup = lookupOf(repo);
  const wanted = collectReachable(request.wants, lookup, { maxDepth: request.depth });
  const held = collectReachable(request.haves, lookup, { allowMissing: true, shallowCut: new Set(request.shallow) });
  const packOids = [...wanted.objects].filter((oid) => !held.objects.has(oid)).sort();
  const objects: Array<{ oid: string; type: GitObjectType; data: Buffer }> = [];
  for (const oid of packOids) {
    const object = getObject(repo, oid);
    if (object !== undefined) objects.push({ oid, type: object.type, data: object.data });
  }
  const shallow = [...wanted.boundary].sort();
  const unshallow = request.shallow.filter((oid) => wanted.objects.has(oid) && !wanted.boundary.has(oid)).sort();
  const acks = request.haves.filter((have) => request.wants.some((want) => isAncestor(lookup, have, want)));
  return { objects, shallow, unshallow, acks };
}

function v2FetchResponse(result: FetchResult, error?: string): Buffer {
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  if (result.acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of result.acks) parts.push(pktLine(`ACK ${ack}\n`));
  parts.push(pktDelim());
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  if (error !== undefined) parts.push(sidebandPacket(3, Buffer.from(`${error}\n`, 'utf8')));
  else parts.push(sidebandData(1, writePack(result.objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0FetchResponse(result: FetchResult, error?: string): Buffer {
  const parts: Buffer[] = [];
  for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (result.acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of result.acks) parts.push(pktLine(`ACK ${ack}\n`));
  if (error !== undefined) parts.push(sidebandPacket(3, Buffer.from(`${error}\n`, 'utf8')));
  else parts.push(sidebandData(1, writePack(result.objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function parseFetchArgs(lines: readonly string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [] };
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const oid = line.slice(5, 45);
      if (isOid(oid)) request.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5, 45);
      if (isOid(oid)) request.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8, 48);
      if (isOid(oid)) request.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(depth) && depth >= 0 && request.depth === undefined) request.depth = depth;
    }
    // deepen-since, deepen-not, filter, thin-pack, no-progress, ofs-delta, done: parsed, ignored.
  }
  return request;
}

function handleUploadPackV2(ctx: GitContext, repo: Repo): GitResult {
  const headers = { 'content-type': 'application/x-git-upload-pack-result' };
  let packets;
  try {
    packets = decodeAllPktLines(ctx.body);
  } catch (error) {
    return textResult(400, oneLine(error instanceof Error ? error.message : String(error)));
  }
  const headLines: string[] = [];
  const argLines: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (inArgs) argLines.push(text);
    else headLines.push(text);
  }
  const commandLine = headLines[0] ?? '';
  if (!commandLine.startsWith('command=')) return textResult(400, 'missing command');
  const command = commandLine.slice('command='.length);

  if (command === 'ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const line of argLines) {
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
    const lines: Buffer[] = [];
    const include = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    const head = defaultTip(repo);
    if (include('HEAD')) {
      if (head !== undefined) {
        let line = `${head} HEAD`;
        if (symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
        lines.push(pktLine(`${line}\n`));
      } else if (unborn) {
        let line = 'unborn HEAD';
        if (symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
        lines.push(pktLine(`${line}\n`));
      }
    }
    const lookup = lookupOf(repo);
    for (const ref of sortedRefs(repo)) {
      if (!include(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel) {
        const object = getObject(repo, ref.oid);
        if (object !== undefined && object.type === 'tag') line += ` peeled:${peelObject(lookup, ref.oid)}`;
      }
      lines.push(pktLine(`${line}\n`));
    }
    lines.push(pktFlush());
    return { status: 200, headers, body: Buffer.concat(lines) };
  }

  if (command === 'fetch') {
    const request = parseFetchArgs(argLines);
    try {
      const result = computeFetch(repo, request);
      return { status: 200, headers, body: v2FetchResponse(result) };
    } catch (error) {
      const empty: FetchResult = { objects: [], shallow: [], unshallow: [], acks: [] };
      return { status: 200, headers, body: v2FetchResponse(empty, oneLine(error instanceof Error ? error.message : String(error))) };
    }
  }

  return textResult(400, `unknown command ${command}`);
}

function handleUploadPackV0(ctx: GitContext, repo: Repo): GitResult {
  const headers = { 'content-type': 'application/x-git-upload-pack-result' };
  let packets;
  try {
    packets = decodeAllPktLines(ctx.body);
  } catch (error) {
    return textResult(400, oneLine(error instanceof Error ? error.message : String(error)));
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  // v0 wants and haves share one line list: wants carry "want ", haves "have ", so one pass works.
  const request = parseFetchArgs(lines);
  try {
    const result = computeFetch(repo, request);
    return { status: 200, headers, body: v0FetchResponse(result) };
  } catch (error) {
    const empty: FetchResult = { objects: [], shallow: [], unshallow: [], acks: [] };
    return { status: 200, headers, body: v0FetchResponse(empty, oneLine(error instanceof Error ? error.message : String(error))) };
  }
}

// --------------------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(ctx: GitContext, repo: Repo): GitResult {
  const headers = { 'content-type': 'application/x-git-receive-pack-result' };
  let packets;
  let consumed = 0;
  try {
    const decoded = decodePktLinesUpToFlush(ctx.body);
    packets = decoded.packets;
    consumed = decoded.consumed;
  } catch (error) {
    return textResult(400, oneLine(error instanceof Error ? error.message : String(error)));
  }
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\u0000');
    if (nul >= 0) text = text.slice(0, nul); // capabilities ride the first command line
    text = text.replace(/\n$/, '');
    const parts = text.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]!) || !isOid(parts[1]!) || !isValidRefName(parts[2]!)) {
      return textResult(400, 'malformed push command');
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }

  // Unpack first, and keep every object even when a ref update is refused (git-faithful).
  const packBytes = ctx.body.subarray(consumed);
  let unpackOk = true;
  let unpackDetail = '';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => getObject(repo, oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (error) {
      unpackOk = false;
      unpackDetail = oneLine(error instanceof Error ? error.message : String(error));
    }
  }

  const lookup = lookupOf(repo);
  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if ((current ?? ZERO_OID) !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'old oid does not match the current tip' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    if (getObject(repo, command.newOid) === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'new tip is not on the server' });
      continue;
    }
    if (command.oldOid === command.newOid) {
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    if (command.oldOid === ZERO_OID || isAncestor(lookup, command.oldOid, command.newOid)) {
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
  }

  const inner: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`)];
  for (const result of results) {
    inner.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  inner.push(pktFlush());
  const parts: Buffer[] = [];
  for (const packet of inner) parts.push(sidebandPacket(1, packet));
  parts.push(pktFlush());
  return { status: 200, headers, body: Buffer.concat(parts) };
}

// --------------------------------------------------------------------------- top level

export function handleGit(ctx: GitContext): GitResult {
  const segments = ctx.path.split('/').filter((part) => part !== '');
  // info/refs is two segments; the pack endpoints are one.
  let endpoint: string;
  if (segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs') {
    endpoint = 'info/refs';
  } else if (segments.length === 3) {
    endpoint = segments[2]!;
  } else {
    return textResult(404, 'Not Found');
  }
  const owner = segments[0]!;
  const repoSegment = segments[1]!;
  if (!repoSegment.endsWith('.git')) return textResult(404, 'Not Found');
  const repoName = repoSegment.slice(0, -'.git'.length);
  if (!NAME_RE.test(owner) || !NAME_RE.test(repoName) || repoName.endsWith('.git')) {
    return textResult(404, 'Not Found');
  }
  if (!ctx.authorized) return textResult(401, 'Unauthorized');
  const repo = ctx.forge.getRepo(owner, repoName);
  if (repo === undefined) return textResult(404, 'Repository not found');

  if (endpoint === 'info/refs' && ctx.method === 'GET') {
    const service = ctx.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return textResult(400, 'missing or unknown service');
    }
    return handleInfoRefs(ctx, repo, service);
  }
  if (endpoint === 'git-upload-pack' && ctx.method === 'POST') {
    if (ctx.headers['git-protocol'] === 'version=2') return handleUploadPackV2(ctx, repo);
    return handleUploadPackV0(ctx, repo);
  }
  if (endpoint === 'git-receive-pack' && ctx.method === 'POST') {
    return handleReceivePack(ctx, repo);
  }
  return textResult(404, 'Not Found');
}
