// REST v3: the porcelain over the forge store. Every handler here is a thin mapping from a route
// to a store operation; the git object store underneath is the same one smart HTTP serves, so a
// commit made through PUT /contents is a real commit a clone can fetch.
//
// Conventions the conformance suite pins down:
// - every reply is JSON (never HTML), errors are {"message": string}
// - pagination honours per_page/page and links the next page with a same-origin Link header
// - unknown owners, repos and numbers are 404 (never 403); duplicate repos are 422 naming
//   "already exists"; a stale contents sha is 409; a conflicted merge is 405.

import {
  VIEWER_LOGIN,
  addIssueComment,
  branchTip,
  commentJson,
  createIssue,
  createLabel,
  createPull,
  createRef,
  deleteFile,
  getObject,
  issueJson,
  labelJson,
  listBranches,
  listCommits,
  listIssues,
  listPulls,
  mergePull,
  nowIso,
  patchIssue,
  pullFiles,
  pullJson,
  readPathAt,
  repoJson,
  resolveRef,
  viewerJson,
  writeFile,
  type Forge,
  type Repo,
} from './store.ts';

export interface RestContext {
  forge: Forge;
  method: string;
  /** The pathname with /api/v3 stripped, still percent-encoded, always starting with '/'. */
  path: string;
  query: URLSearchParams;
  body: Buffer;
  host: string;
  /** The Authorization header matched the trial token. Every REST route requires it. */
  authorized: boolean;
}

export interface RestResult {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
  empty?: boolean;
}

function err(status: number, message: string): RestResult {
  return { status, json: { message } };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseBody(ctx: RestContext): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (ctx.body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '', 10);
  const rawPage = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(rawPerPage) && rawPerPage > 0 ? Math.min(rawPerPage, 100) : 30;
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  return { perPage, page };
}

/** Slice a list for the requested page and build the Link header (absolute, same-origin). */
function paginate<T>(items: readonly T[], query: URLSearchParams, path: string, host: string): { page: T[]; link: string | null } {
  const { perPage, page } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const urlFor = (target: number): string => `http://${host}${path}?per_page=${perPage}&page=${target}`;
  const links: string[] = [];
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  if (totalPages > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  return { page: pageItems, link: links.length > 0 ? links.join(', ') : null };
}

function parseNumber(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  const value = Number(segment);
  return Number.isSafeInteger(value) ? value : null;
}

/** "Name <email> 1735689600 +0000" -> the author shape REST serves. */
function identityJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.+?) <([^>]+)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: nowIso() };
  const date = new Date(Number(match[3]) * 1000).toISOString();
  return { name: match[1]!, email: match[2]!, date };
}

function stripForkPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

export function handleRest(ctx: RestContext): RestResult {
  if (!ctx.authorized) return err(401, 'Unauthorized');
  const rawSegments = ctx.path.split('/').filter((part) => part !== '');
  const seg = rawSegments.map(decodeSegment);
  const { method, forge } = ctx;

  // GET /api/v3 and /api/v3/ — the root document, with the scopes header the suite reads.
  if (seg.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return {
      status: 200,
      json: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  if (seg[0] === 'meta') {
    if (method === 'GET' && seg.length === 1) return { status: 200, json: { installed_version: 'github-core-clone/1.0.0' } };
    return err(404, 'Not Found');
  }

  if (seg[0] === 'user') {
    if (seg.length === 1 && method === 'GET') return { status: 200, json: viewerJson() };
    if (seg.length === 2 && seg[1] === 'repos') {
      if (method === 'GET') {
        const { page, link } = paginate(forge.listRepos(), ctx.query, '/api/v3/user/repos', ctx.host);
        const result: RestResult = { status: 200, json: page.map(repoJson) };
        if (link !== null) result.headers = { link };
        return result;
      }
      if (method === 'POST') {
        const parsed = parseBody(ctx);
        if (!parsed.ok) return err(400, 'Problems parsing JSON');
        const name = asString(parsed.value.name);
        if (name === undefined || name === '' || name.length > 100 || name.includes('/')) {
          return err(422, 'name is required');
        }
        const repo = forge.createRepo(name, asBoolean(parsed.value.private) ?? false, asString(parsed.value.description) ?? '');
        if (repo === null) return err(422, `Repository "${VIEWER_LOGIN}/${name}" already exists`);
        return { status: 201, json: repoJson(repo) };
      }
    }
    return err(404, 'Not Found');
  }

  if (seg[0] !== 'repos' || seg.length < 3) return err(404, 'Not Found');
  const owner = seg[1]!;
  const repoName = seg[2]!;
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return err(404, 'Not Found');
  const rest = seg.slice(3);

  // /repos/{owner}/{repo}
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, json: repoJson(repo) };
    if (method === 'PATCH') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const description = asString(parsed.value.description);
      if (description !== undefined) repo.description = description;
      const isPrivate = asBoolean(parsed.value.private);
      if (isPrivate !== undefined) repo.private = isPrivate;
      const defaultBranch = asString(parsed.value.default_branch);
      if (defaultBranch !== undefined && defaultBranch !== '') repo.defaultBranch = defaultBranch;
      repo.updatedAt = nowIso();
      return { status: 200, json: repoJson(repo) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, repoName);
      return { status: 204, empty: true };
    }
    return err(404, 'Not Found');
  }

  const head = rest[0]!;

  if (head === 'branches') {
    if (method !== 'GET') return err(404, 'Not Found');
    if (rest.length === 1) {
      return { status: 200, json: listBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha }, protected: false })) };
    }
    const branch = rest.slice(1).join('/');
    const sha = branchTip(repo, branch);
    if (sha === undefined) return err(404, 'Branch not found');
    return { status: 200, json: { name: branch, commit: { sha }, protected: false } };
  }

  if (head === 'commits') {
    if (method !== 'GET' || rest.length !== 1) return err(404, 'Not Found');
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const commits = listCommits(repo, ref);
    return {
      status: 200,
      json: commits.map((commit) => ({
        sha: commit.sha,
        commit: {
          message: commit.message,
          author: identityJson(commit.author),
          committer: identityJson(commit.committer),
        },
        parents: commit.parents.map((sha) => ({ sha })),
      })),
    };
  }

  if (head === 'contents') {
    return handleContents(ctx, repo, rest.slice(1));
  }

  if (head === 'git') {
    if (rest.length === 2 && rest[1] === 'refs' && method === 'POST') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const ref = asString(parsed.value.ref);
      const sha = asString(parsed.value.sha);
      if (ref === undefined || sha === undefined) return err(422, 'ref and sha are required');
      const created = createRef(repo, ref, sha);
      if (!created.ok) {
        if (created.error === 'exists') return err(422, 'Reference already exists');
        if (created.error === 'bad-name') return err(422, 'Invalid ref name');
        return err(422, 'Invalid sha');
      }
      return { status: 201, json: { ref, object: { sha: created.sha, type: 'commit' } } };
    }
    if (rest.length >= 3 && rest[1] === 'refs' && method === 'GET') {
      const refname = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(refname);
      if (sha === undefined) return err(404, 'Reference not found');
      const object = getObject(repo, sha);
      return { status: 200, json: { ref: refname, object: { sha, type: object?.type ?? 'commit' } } };
    }
    return err(404, 'Not Found');
  }

  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const name = asString(parsed.value.name);
      if (name === undefined || name === '') return err(422, 'name is required');
      const label = createLabel(repo, name, asString(parsed.value.color) ?? 'ededed');
      return { status: 201, json: labelJson(label) };
    }
    return err(404, 'Not Found');
  }

  if (head === 'issues') {
    return handleIssues(ctx, repo, rest.slice(1));
  }

  if (head === 'pulls') {
    return handlePulls(ctx, repo, rest.slice(1));
  }

  return err(404, 'Not Found');
}

function handleContents(ctx: RestContext, repo: Repo, pathSegments: string[]): RestResult {
  const { method } = ctx;
  const path = pathSegments.join('/');
  if (path === '') return err(404, 'Not Found');

  if (method === 'GET') {
    const ref = ctx.query.get('ref') ?? repo.defaultBranch;
    const tip = resolveRef(repo, ref);
    if (tip === undefined) return err(404, 'Not Found');
    const read = readPathAt(repo, tip, path);
    if (read.kind === 'missing') return err(404, 'Not Found');
    if (read.kind === 'file') {
      const name = pathSegments[pathSegments.length - 1]!;
      return {
        status: 200,
        json: {
          type: 'file',
          encoding: 'base64',
          content: read.data.toString('base64'),
          sha: read.blobOid,
          size: read.data.length,
          name,
          path,
        },
      };
    }
    return {
      status: 200,
      json: read.entries.map((entry) => {
        const object = entry.type === 'file' ? getObject(repo, entry.oid) : undefined;
        return { type: entry.type, name: entry.name, path: entry.path, sha: entry.oid, size: object?.data.length ?? 0 };
      }),
    };
  }

  if (method === 'PUT') {
    const parsed = parseBody(ctx);
    if (!parsed.ok) return err(400, 'Problems parsing JSON');
    const content = asString(parsed.value.content);
    if (content === undefined) return err(422, 'content is required');
    const branch = asString(parsed.value.branch) ?? repo.defaultBranch;
    const contentBytes = Buffer.from(content, 'base64');
    const written = writeFile(repo, {
      branch,
      path,
      content: contentBytes,
      message: asString(parsed.value.message) ?? '',
      sha: asString(parsed.value.sha),
    });
    if (!written.ok) {
      if (written.error === 'stale-sha') return err(409, 'sha does not match the current file');
      if (written.error === 'missing-sha') return err(422, 'sha is required to update a file');
      return err(404, 'Branch not found');
    }
    const name = pathSegments[pathSegments.length - 1]!;
    return {
      status: written.created ? 201 : 200,
      json: {
        content: { name, path, sha: written.blobSha, size: contentBytes.length, encoding: 'base64' },
        commit: { sha: written.commitSha, message: asString(parsed.value.message) ?? '' },
      },
    };
  }

  if (method === 'DELETE') {
    const parsed = parseBody(ctx);
    if (!parsed.ok) return err(400, 'Problems parsing JSON');
    const branch = asString(parsed.value.branch) ?? repo.defaultBranch;
    const deleted = deleteFile(repo, {
      branch,
      path,
      message: asString(parsed.value.message) ?? '',
      sha: asString(parsed.value.sha),
    });
    if (!deleted.ok) {
      if (deleted.error === 'missing') return err(404, 'Not Found');
      if (deleted.error === 'stale-sha') return err(409, 'sha does not match the current file');
      return err(404, 'Branch not found');
    }
    return { status: 200, json: { commit: { sha: deleted.commitSha } } };
  }

  return err(404, 'Not Found');
}

function handleIssues(ctx: RestContext, repo: Repo, rest: string[]): RestResult {
  const { method, forge } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') {
      const issues = listIssues(repo, {
        state: ctx.query.get('state') ?? undefined,
        sort: ctx.query.get('sort') ?? undefined,
        direction: ctx.query.get('direction') ?? undefined,
      });
      const { page, link } = paginate(issues, ctx.query, ctx.path, ctx.host);
      const result: RestResult = { status: 200, json: page.map(issueJson) };
      if (link !== null) result.headers = { link };
      return result;
    }
    if (method === 'POST') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const title = asString(parsed.value.title);
      if (title === undefined || title === '') return err(422, 'title is required');
      const created = createIssue(forge, repo, {
        title,
        body: asString(parsed.value.body) ?? '',
        labelNames: asStringArray(parsed.value.labels),
      });
      if (!created.ok) return err(422, `Label "${created.label}" does not exist`);
      return { status: 201, json: issueJson(created.issue) };
    }
    return err(404, 'Not Found');
  }

  const number = parseNumber(rest[0]!);
  if (number === null) return err(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (issue === undefined) return err(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return { status: 200, json: issueJson(issue) };
    if (method === 'PATCH') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const patched = patchIssue(forge, repo, number, {
        state: asString(parsed.value.state),
        title: asString(parsed.value.title),
        body: asString(parsed.value.body),
      });
      if (patched === undefined) return err(404, 'Not Found');
      return { status: 200, json: issueJson(patched) };
    }
    return err(404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      return { status: 200, json: issue.comments.map(commentJson) };
    }
    if (method === 'POST') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const body = asString(parsed.value.body);
      if (body === undefined) return err(422, 'body is required');
      const comment = addIssueComment(forge, repo, issue, body);
      return { status: 201, json: commentJson(comment) };
    }
  }
  return err(404, 'Not Found');
}

function handlePulls(ctx: RestContext, repo: Repo, rest: string[]): RestResult {
  const { method, forge } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') {
      const pulls = listPulls(repo, ctx.query.get('state') ?? 'open');
      const { page, link } = paginate(pulls, ctx.query, ctx.path, ctx.host);
      const result: RestResult = { status: 200, json: page.map((pr) => pullJson(repo, pr)) };
      if (link !== null) result.headers = { link };
      return result;
    }
    if (method === 'POST') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return err(400, 'Problems parsing JSON');
      const head = asString(parsed.value.head);
      const base = asString(parsed.value.base);
      const title = asString(parsed.value.title);
      if (head === undefined || base === undefined || title === undefined) {
        return err(422, 'head, base and title are required');
      }
      const created = createPull(forge, repo, {
        head: stripForkPrefix(head),
        base: stripForkPrefix(base),
        title,
        body: asString(parsed.value.body) ?? '',
      });
      if (!created.ok) return err(422, 'head or base branch does not exist');
      return { status: 201, json: pullJson(repo, created.pr) };
    }
    return err(404, 'Not Found');
  }

  const number = parseNumber(rest[0]!);
  if (number === null) return err(404, 'Not Found');
  const pr = repo.pulls.get(number);
  if (pr === undefined) return err(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return { status: 200, json: pullJson(repo, pr) };
    return err(404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') return err(404, 'Not Found');
    return { status: 200, json: pullFiles(repo, pr) };
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') return err(404, 'Not Found');
    const parsed = parseBody(ctx);
    if (!parsed.ok) return err(400, 'Problems parsing JSON');
    const merged = mergePull(forge, repo, pr);
    if (!merged.ok) {
      if (merged.error === 'conflict') return err(405, 'Merge conflict: the pull request cannot be merged cleanly');
      if (merged.error === 'already-merged') return err(405, 'Pull request has already been merged');
      return err(422, 'The pull request cannot be merged');
    }
    return { status: 200, json: { merged: true, sha: merged.sha, message: 'Pull request successfully merged' } };
  }

  return err(404, 'Not Found');
}
