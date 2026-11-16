// The forge's state: repositories, their git object stores and refs, and the issues, pull
// requests, labels and comments that live beside them. Every surface (REST, GraphQL, MCP, git
// smart HTTP) reads and writes this one store, so an object created on one surface is the same
// object on the others. All timestamps are the one fixed trial time: nothing here reads a clock.

import {
  ZERO_OID,
  buildCommit,
  buildTreeFromMap,
  commitHistory,
  diffFileMaps,
  flattenTree,
  hashObject,
  isOid,
  mergeBase,
  normOid,
  parseCommit,
  parseTree,
  threeWayMerge,
  type FileDiff,
  type FlatFile,
  type GitObject,
  type GitObjectType,
} from './gitstore.ts';

// --------------------------------------------------------------------------- identity and time

/** The token's login, fixed by the contest's scenario seed (verified against buildScenario()). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

const DEFAULT_NOW_ISO = '2025-01-01T00:00:00.000Z';

/** The one timestamp every served value carries: MAKEFUN_TRIAL_NOW, normalized to ISO, or the default. */
function computeNow(): { iso: string; epoch: number } {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    if (/^\d+$/.test(raw)) {
      const epoch = Number(raw);
      const iso = new Date(epoch * 1000).toISOString();
      if (iso !== 'Invalid Date') return { iso, epoch };
    } else {
      const ms = Date.parse(raw);
      if (Number.isFinite(ms)) return { iso: new Date(ms).toISOString(), epoch: Math.floor(ms / 1000) };
    }
  }
  return { iso: DEFAULT_NOW_ISO, epoch: 1735689600 };
}

const NOW = computeNow();

export function nowIso(): string {
  return NOW.iso;
}

export function nowEpoch(): number {
  return NOW.epoch;
}

/** The full author/committer line for commits the forge itself creates. */
export function authorLine(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${NOW.epoch} +0000`;
}

// --------------------------------------------------------------------------- global ids (GraphQL)

export type GlobalIdKind = 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment';

/** An opaque, stable Relay id: base64("Kind:<numeric id>"). Never the plain number. */
export function globalId(kind: GlobalIdKind, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

export function decodeGlobalId(value: string): { kind: GlobalIdKind; id: number } | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const match = /^(Repository|Issue|PullRequest|IssueComment):(\d+)$/.exec(text);
    if (match === null) return null;
    // The encoding must round-trip: reject strings that merely decode to the shape.
    if (Buffer.from(text, 'utf8').toString('base64') !== value) return null;
    return { kind: match[1] as GlobalIdKind, id: Number(match[2]) };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- domain objects

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface IssueComment {
  readonly globalId: number;
  readonly body: string;
  readonly userLogin: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Issue {
  readonly globalId: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  readonly userLogin: string;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly comments: IssueComment[];
  /** Creation order within the repo (== number order, but kept explicit for sorting). */
  readonly seq: number;
  /** Bumped on every mutation, for UPDATED_AT ordering. */
  updatedSeq: number;
}

export interface PullRequest {
  readonly globalId: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  /** The head branch's tip when the pull request was created (a fallback if the branch moves on). */
  readonly headShaAtCreation: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly userLogin: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly comments: IssueComment[];
  readonly seq: number;
  updatedSeq: number;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly ownerLogin: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly seq: number;
  /** The git object store: oid -> object. REST and git share it. */
  readonly objects: Map<string, GitObject>;
  /** Full ref names (refs/heads/..., refs/tags/...) -> tip oid. */
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  /** The one shared counter for issue and pull request numbers, from 1 (GitHub's behaviour). */
  nextNumber: number;
  nextLabelId: number;
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueGlobalId = 1;
  private nextPrGlobalId = 1;
  private nextCommentGlobalId = 1;
  private repoSeq = 0;
  private mutationSeq = 0;
  /** Global indexes for Relay id resolution. */
  readonly issueByGlobal = new Map<number, { repo: Repo; issue: Issue }>();
  readonly prByGlobal = new Map<number, { repo: Repo; pr: PullRequest }>();
  readonly repoById = new Map<number, Repo>();

  nextMutationSeq(): number {
    this.mutationSeq += 1;
    return this.mutationSeq;
  }

  /** Create a repository owned by the viewer. Returns null when (owner, name) already exists. */
  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    const key = `${VIEWER_LOGIN}/${name}`;
    if (this.repos.has(key)) return null;
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      ownerLogin: VIEWER_LOGIN,
      private: isPrivate,
      description,
      defaultBranch: 'main',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      seq: this.repoSeq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextLabelId: 1,
    };
    this.repos.set(key, repo);
    this.repoById.set(repo.id, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    const repo = this.repos.get(`${owner}/${name}`);
    if (repo === undefined) return false;
    this.repos.delete(`${owner}/${name}`);
    this.repoById.delete(repo.id);
    for (const issue of repo.issues.values()) this.issueByGlobal.delete(issue.globalId);
    for (const pr of repo.pulls.values()) this.prByGlobal.delete(pr.globalId);
    return true;
  }

  /** All repositories in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  allocIssueGlobalId(): number {
    return this.nextIssueGlobalId++;
  }

  allocPrGlobalId(): number {
    return this.nextPrGlobalId++;
  }

  allocCommentGlobalId(): number {
    return this.nextCommentGlobalId++;
  }
}

// --------------------------------------------------------------------------- git object helpers

/** Store an object (idempotent: the same bytes always hash to the same id) and return its id. */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function lookupOf(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid: string) => repo.objects.get(oid);
}

export function refTip(repo: Repo, refname: string): string | undefined {
  return repo.refs.get(refname);
}

export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

export function defaultTip(repo: Repo): string | undefined {
  return branchTip(repo, repo.defaultBranch);
}

/**
 * Resolve a ref spelling to a commit id: a branch name, a full ref name, or a 40-hex commit id
 * that the store holds. Undefined when nothing matches.
 */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  const direct = branchTip(repo, ref);
  if (direct !== undefined) return direct;
  const full = refTip(repo, ref);
  if (full !== undefined) return full;
  const oid = normOid(ref);
  if (oid !== null) {
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit') return oid;
  }
  return undefined;
}

// --------------------------------------------------------------------------- contents

export type ReadPathResult =
  | { kind: 'file'; blobOid: string; data: Buffer; mode: string }
  | { kind: 'dir'; entries: Array<{ name: string; path: string; oid: string; type: 'file' | 'dir' }> }
  | { kind: 'missing' };

/** Read a path at a commit: a file's bytes, a directory's entries, or missing. */
export function readPathAt(repo: Repo, commitOid: string, path: string): ReadPathResult {
  const lookup = lookupOf(repo);
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return { kind: 'missing' };
  const treeOid = parseCommit(commit.data).tree;
  const segments = path.split('/').filter((part) => part !== '');
  let currentTree = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const treeObject = repo.objects.get(currentTree);
    if (treeObject === undefined || treeObject.type !== 'tree') return { kind: 'missing' };
    const entry = parseTree(treeObject.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return { kind: 'missing' };
    const last = index === segments.length - 1;
    if (entry.mode === '40000') {
      if (last) {
        const dirObject = repo.objects.get(entry.oid);
        if (dirObject === undefined || dirObject.type !== 'tree') return { kind: 'missing' };
        return {
          kind: 'dir',
          entries: parseTree(dirObject.data).map((child) => ({
            name: child.name,
            path: `${path}/${child.name}`,
            oid: child.oid,
            type: child.mode === '40000' ? ('dir' as const) : ('file' as const),
          })),
        };
      }
      currentTree = entry.oid;
      continue;
    }
    if (!last) return { kind: 'missing' };
    const blob = repo.objects.get(entry.oid);
    if (blob === undefined || blob.type !== 'blob') return { kind: 'missing' };
    return { kind: 'file', blobOid: entry.oid, data: blob.data, mode: entry.mode };
  }
  // The root itself: list the root tree.
  const rootObject = repo.objects.get(treeOid);
  if (rootObject === undefined || rootObject.type !== 'tree') return { kind: 'missing' };
  return {
    kind: 'dir',
    entries: parseTree(rootObject.data).map((child) => ({
      name: child.name,
      path: child.name,
      oid: child.oid,
      type: child.mode === '40000' ? ('dir' as const) : ('file' as const),
    })),
  };
}

export type WriteFileResult =
  | { ok: true; commitSha: string; blobSha: string; created: boolean }
  | { ok: false; error: 'stale-sha' | 'missing-sha' | 'missing-branch' };

/**
 * Write a file on a branch, creating one commit. An unborn repository takes its first commit on
 * the default branch; a branch that does not exist yet is created from the default tip. A stale
 * `sha` (not the file's current blob) is refused; an update without one is refused too.
 */
export function writeFile(
  repo: Repo,
  options: { branch: string; path: string; content: Buffer; message: string; sha?: string },
): WriteFileResult {
  const lookup = lookupOf(repo);
  let tip = branchTip(repo, options.branch);
  if (tip === undefined) {
    if (repo.refs.size === 0 && options.branch === repo.defaultBranch) {
      tip = undefined; // unborn: the first commit lands on the default branch
    } else if (repo.refs.size === 0) {
      tip = undefined; // unborn, named branch: the first commit creates it
    } else {
      const base = defaultTip(repo);
      if (base === undefined) return { ok: false, error: 'missing-branch' };
      tip = base; // lenient: a new branch starts at the default tip
    }
  }
  const baseFiles = tip === undefined ? new Map<string, FlatFile>() : flattenTree(lookup, parseCommit(getObject(repo, tip)!.data).tree);
  const existing = baseFiles.get(options.path);
  if (existing !== undefined) {
    if (options.sha === undefined) return { ok: false, error: 'missing-sha' };
    if (normOid(options.sha) !== existing.oid) return { ok: false, error: 'stale-sha' };
  }
  const blobSha = putObject(repo, 'blob', options.content);
  const next = new Map(baseFiles);
  next.set(options.path, { oid: blobSha, mode: existing?.mode ?? '100644' });
  const treeOid = buildTreeFromMap(next, (type, data) => putObject(repo, type, data));
  const parents = tip === undefined ? [] : [tip];
  const commitSha = putObject(repo, 'commit', buildCommit(treeOid, parents, authorLine(), authorLine(), options.message));
  repo.refs.set(`refs/heads/${options.branch}`, commitSha);
  return { ok: true, commitSha, blobSha, created: existing === undefined };
}

export type DeleteFileResult =
  | { ok: true; commitSha: string }
  | { ok: false; error: 'missing' | 'stale-sha' | 'missing-branch' };

/** Delete a file on a branch, creating one commit. A stale `sha` is refused. */
export function deleteFile(
  repo: Repo,
  options: { branch: string; path: string; message: string; sha?: string },
): DeleteFileResult {
  const lookup = lookupOf(repo);
  const tip = branchTip(repo, options.branch);
  if (tip === undefined) return { ok: false, error: 'missing-branch' };
  const commit = getObject(repo, tip);
  if (commit === undefined || commit.type !== 'commit') return { ok: false, error: 'missing-branch' };
  const files = flattenTree(lookup, parseCommit(commit.data).tree);
  const existing = files.get(options.path);
  if (existing === undefined) return { ok: false, error: 'missing' };
  if (options.sha !== undefined && normOid(options.sha) !== existing.oid) return { ok: false, error: 'stale-sha' };
  const next = new Map(files);
  next.delete(options.path);
  const treeOid = buildTreeFromMap(next, (type, data) => putObject(repo, type, data));
  const commitSha = putObject(repo, 'commit', buildCommit(treeOid, [tip], authorLine(), authorLine(), options.message));
  repo.refs.set(`refs/heads/${options.branch}`, commitSha);
  return { ok: true, commitSha };
}

// --------------------------------------------------------------------------- refs, branches, commits

export type CreateRefResult = { ok: true; sha: string } | { ok: false; error: 'exists' | 'unknown-sha' | 'bad-name' };

/** Create a ref at a commit (POST /git/refs). The target must already be in the store. */
export function createRef(repo: Repo, refname: string, sha: string): CreateRefResult {
  if (!refname.startsWith('refs/') || refname.length < 6) return { ok: false, error: 'bad-name' };
  if (repo.refs.has(refname)) return { ok: false, error: 'exists' };
  const oid = normOid(sha);
  if (oid === null) return { ok: false, error: 'unknown-sha' };
  const object = repo.objects.get(oid);
  if (object === undefined) return { ok: false, error: 'unknown-sha' };
  if (refname.startsWith('refs/heads/') && object.type !== 'commit') return { ok: false, error: 'unknown-sha' };
  repo.refs.set(refname, oid);
  return { ok: true, sha: oid };
}

export function listBranches(repo: Repo): Array<{ name: string; sha: string }> {
  const branches: Array<{ name: string; sha: string }> = [];
  for (const [refname, sha] of repo.refs) {
    if (refname.startsWith('refs/heads/')) branches.push({ name: refname.slice('refs/heads/'.length), sha });
  }
  return branches;
}

/** The commit history of a ref, newest first, as parsed views. */
export function listCommits(repo: Repo, ref: string): Array<{ sha: string; message: string; author: string; committer: string; tree: string; parents: string[] }> {
  const tip = resolveRef(repo, ref);
  if (tip === undefined) return [];
  const lookup = lookupOf(repo);
  const out: Array<{ sha: string; message: string; author: string; committer: string; tree: string; parents: string[] }> = [];
  for (const sha of commitHistory(lookup, tip)) {
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') continue;
    const view = parseCommit(object.data);
    out.push({ sha, message: view.message, author: view.author, committer: view.committer, tree: view.tree, parents: view.parents });
  }
  return out;
}

// --------------------------------------------------------------------------- labels and issues

/** Create a label (idempotent by name: re-creating returns the existing label). */
export function createLabel(repo: Repo, name: string, color: string): Label {
  const existing = repo.labels.get(name);
  if (existing !== undefined) return existing;
  const label: Label = { id: repo.nextLabelId++, name, color, description: '' };
  repo.labels.set(name, label);
  return label;
}

export type CreateIssueResult = { ok: true; issue: Issue } | { ok: false; error: 'bad-label'; label: string };

/** Create an issue. Every named label must already exist on the repository. */
export function createIssue(
  forge: Forge,
  repo: Repo,
  options: { title: string; body: string; labelNames: string[] },
): CreateIssueResult {
  const labels: Label[] = [];
  for (const name of options.labelNames) {
    const label = repo.labels.get(name);
    if (label === undefined) return { ok: false, error: 'bad-label', label: name };
    labels.push(label);
  }
  const number = repo.nextNumber++;
  const issue: Issue = {
    globalId: forge.allocIssueGlobalId(),
    number,
    title: options.title,
    body: options.body,
    state: 'open',
    labels,
    userLogin: VIEWER_LOGIN,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    closedAt: null,
    comments: [],
    seq: number,
    updatedSeq: forge.nextMutationSeq(),
  };
  repo.issues.set(number, issue);
  forge.issueByGlobal.set(issue.globalId, { repo, issue });
  return { ok: true, issue };
}

export function patchIssue(
  forge: Forge,
  repo: Repo,
  number: number,
  patch: { state?: string; title?: string; body?: string },
): Issue | undefined {
  const issue = repo.issues.get(number);
  if (issue === undefined) return undefined;
  if (patch.state === 'open' || patch.state === 'closed') {
    issue.state = patch.state;
    issue.closedAt = patch.state === 'closed' ? nowIso() : null;
  }
  if (typeof patch.title === 'string') issue.title = patch.title;
  if (typeof patch.body === 'string') issue.body = patch.body;
  issue.updatedAt = nowIso();
  issue.updatedSeq = forge.nextMutationSeq();
  return issue;
}

export function addIssueComment(forge: Forge, repo: Repo, issue: Issue, body: string): IssueComment {
  const comment: IssueComment = {
    globalId: forge.allocCommentGlobalId(),
    body,
    userLogin: VIEWER_LOGIN,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  issue.comments.push(comment);
  issue.updatedSeq = forge.nextMutationSeq();
  return comment;
}

/** Issues filtered and ordered: state filter, created/updated ordering, creation-order default. */
export function listIssues(
  repo: Repo,
  options: { state?: string; sort?: string; direction?: string },
): Issue[] {
  let issues = [...repo.issues.values()];
  const state = options.state ?? 'open';
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  const direction = options.direction === 'desc' ? -1 : 1;
  const sort = options.sort ?? 'created';
  if (sort === 'updated') {
    issues.sort((a, b) => (a.updatedSeq - b.updatedSeq || a.number - b.number) * direction);
  } else if (sort === 'comments') {
    issues.sort((a, b) => (a.comments.length - b.comments.length || a.number - b.number) * direction);
  } else {
    issues.sort((a, b) => (a.seq - b.seq) * direction);
  }
  return issues;
}

// --------------------------------------------------------------------------- pull requests

export type CreatePullResult = { ok: true; pr: PullRequest } | { ok: false; error: 'missing-branch' };

/** Create a pull request. Both branches must exist. */
export function createPull(
  forge: Forge,
  repo: Repo,
  options: { head: string; base: string; title: string; body: string },
): CreatePullResult {
  const headSha = branchTip(repo, options.head);
  const baseSha = branchTip(repo, options.base);
  if (headSha === undefined || baseSha === undefined) return { ok: false, error: 'missing-branch' };
  const number = repo.nextNumber++;
  const pr: PullRequest = {
    globalId: forge.allocPrGlobalId(),
    number,
    title: options.title,
    body: options.body,
    state: 'open',
    headRef: options.head,
    baseRef: options.base,
    headShaAtCreation: headSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    userLogin: VIEWER_LOGIN,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    comments: [],
    seq: number,
    updatedSeq: forge.nextMutationSeq(),
  };
  repo.pulls.set(number, pr);
  forge.prByGlobal.set(pr.globalId, { repo, pr });
  return { ok: true, pr };
}

/** The head/base shas, resolved live from the branches (the creation sha is the fallback). */
export function pullHeadSha(repo: Repo, pr: PullRequest): string {
  return branchTip(repo, pr.headRef) ?? pr.headShaAtCreation;
}

export function pullBaseSha(repo: Repo, pr: PullRequest): string {
  return branchTip(repo, pr.baseRef) ?? ZERO_OID;
}

export function listPulls(repo: Repo, state: string): PullRequest[] {
  let pulls = [...repo.pulls.values()];
  if (state === 'open' || state === 'closed') pulls = pulls.filter((pr) => pr.state === state);
  pulls.sort((a, b) => a.seq - b.seq);
  return pulls;
}

/** The file diff of a pull request: merge-base tree vs head-tip tree, with line counts. */
export function pullFiles(
  repo: Repo,
  pr: PullRequest,
): Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number; sha: string }> {
  const lookup = lookupOf(repo);
  const headSha = pullHeadSha(repo, pr);
  const baseSha = pullBaseSha(repo, pr);
  const baseCommit = headSha === ZERO_OID ? undefined : getObject(repo, headSha);
  const baseTipCommit = baseSha === ZERO_OID ? undefined : getObject(repo, baseSha);
  if (baseCommit === undefined || baseCommit.type !== 'commit' || baseTipCommit === undefined || baseTipCommit.type !== 'commit') {
    return [];
  }
  const mergeBaseSha = mergeBase(lookup, baseSha, headSha);
  const mergeBaseTree = mergeBaseSha === null ? null : parseCommit(getObject(repo, mergeBaseSha)!.data).tree;
  const baseFiles = mergeBaseTree === null ? new Map<string, FlatFile>() : flattenTree(lookup, mergeBaseTree);
  const headFiles = flattenTree(lookup, parseCommit(baseCommit.data).tree);
  const out: Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number; sha: string }> = [];
  for (const diff of diffFileMaps(baseFiles, headFiles)) {
    const oldData = diff.oldOid === null ? null : getObject(repo, diff.oldOid)?.data ?? null;
    const newData = diff.newOid === null ? null : getObject(repo, diff.newOid)?.data ?? null;
    const { additions, deletions } = countLineChanges(oldData, newData);
    out.push({
      filename: diff.path,
      status: diff.status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: diff.newOid ?? diff.oldOid ?? ZERO_OID,
    });
  }
  return out;
}

/** Line counts for a changed file: added-file lines, removed-file lines, or a multiset diff. */
export function countLineChanges(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const linesOf = (data: Buffer): string[] => {
    const text = data.toString('utf8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    return lines;
  };
  if (oldData === null && newData === null) return { additions: 0, deletions: 0 };
  if (oldData === null) return { additions: linesOf(newData!).length, deletions: 0 };
  if (newData === null) return { additions: 0, deletions: linesOf(oldData).length };
  const oldCounts = new Map<string, number>();
  for (const line of linesOf(oldData)) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  const newCounts = new Map<string, number>();
  for (const line of linesOf(newData)) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) additions += Math.max(0, count - (oldCounts.get(line) ?? 0));
  for (const [line, count] of oldCounts) deletions += Math.max(0, count - (newCounts.get(line) ?? 0));
  return { additions, deletions };
}

export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

/** Whether the pull request merges cleanly, by the same three-way check the merge uses. */
export function pullMergeable(repo: Repo, pr: PullRequest): Mergeable {
  const verdict = planMerge(repo, pr);
  if (verdict === 'uncomputable') return 'UNKNOWN';
  if (verdict === 'conflict') return 'CONFLICTING';
  return 'MERGEABLE';
}

function planMerge(repo: Repo, pr: PullRequest): 'ok' | 'conflict' | 'uncomputable' {
  const lookup = lookupOf(repo);
  const headSha = pullHeadSha(repo, pr);
  const baseSha = pullBaseSha(repo, pr);
  if (headSha === ZERO_OID || baseSha === ZERO_OID) return 'uncomputable';
  const headCommit = getObject(repo, headSha);
  const baseCommit = getObject(repo, baseSha);
  if (headCommit === undefined || headCommit.type !== 'commit' || baseCommit === undefined || baseCommit.type !== 'commit') {
    return 'uncomputable';
  }
  const mergeBaseSha = mergeBase(lookup, baseSha, headSha);
  const mergeBaseTree = mergeBaseSha === null ? null : parseCommit(getObject(repo, mergeBaseSha)!.data).tree;
  const baseFiles = mergeBaseTree === null ? new Map<string, FlatFile>() : flattenTree(lookup, mergeBaseTree);
  const oursFiles = flattenTree(lookup, parseCommit(baseCommit.data).tree);
  const theirsFiles = flattenTree(lookup, parseCommit(headCommit.data).tree);
  const { conflicts } = threeWayMerge(baseFiles, oursFiles, theirsFiles);
  return conflicts.length > 0 ? 'conflict' : 'ok';
}

export type MergePullResult =
  | { ok: true; sha: string }
  | { ok: false; error: 'conflict' | 'already-merged' | 'uncomputable' };

/**
 * Squash-merge a pull request: one new commit on the base branch whose tree is the three-way
 * merge result. A conflict refuses with nothing changed.
 */
export function mergePull(forge: Forge, repo: Repo, pr: PullRequest): MergePullResult {
  if (pr.merged) return { ok: false, error: 'already-merged' };
  const lookup = lookupOf(repo);
  const headSha = pullHeadSha(repo, pr);
  const baseSha = pullBaseSha(repo, pr);
  if (headSha === ZERO_OID || baseSha === ZERO_OID) return { ok: false, error: 'uncomputable' };
  const headCommit = getObject(repo, headSha);
  const baseCommit = getObject(repo, baseSha);
  if (headCommit === undefined || headCommit.type !== 'commit' || baseCommit === undefined || baseCommit.type !== 'commit') {
    return { ok: false, error: 'uncomputable' };
  }
  const mergeBaseSha = mergeBase(lookup, baseSha, headSha);
  const mergeBaseTree = mergeBaseSha === null ? null : parseCommit(getObject(repo, mergeBaseSha)!.data).tree;
  const baseFiles = mergeBaseTree === null ? new Map<string, FlatFile>() : flattenTree(lookup, mergeBaseTree);
  const oursFiles = flattenTree(lookup, parseCommit(baseCommit.data).tree);
  const theirsFiles = flattenTree(lookup, parseCommit(headCommit.data).tree);
  const { merged, conflicts } = threeWayMerge(baseFiles, oursFiles, theirsFiles);
  if (conflicts.length > 0) return { ok: false, error: 'conflict' };
  const treeOid = buildTreeFromMap(merged, (type, data) => putObject(repo, type, data));
  const message = `${pr.title} (#${pr.number})`;
  const sha = putObject(repo, 'commit', buildCommit(treeOid, [baseSha], authorLine(), authorLine(), message));
  repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = nowIso();
  pr.mergeCommitSha = sha;
  pr.updatedAt = nowIso();
  pr.updatedSeq = forge.nextMutationSeq();
  return { ok: true, sha };
}

export function addPullComment(forge: Forge, pr: PullRequest, body: string): IssueComment {
  const comment: IssueComment = {
    globalId: forge.allocCommentGlobalId(),
    body,
    userLogin: VIEWER_LOGIN,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  pr.comments.push(comment);
  pr.updatedSeq = forge.nextMutationSeq();
  return comment;
}

// --------------------------------------------------------------------------- JSON views (shared by REST, MCP, GraphQL)

export function userJson(login: string): { login: string; id: number } {
  return { login, id: login === VIEWER_LOGIN ? VIEWER_ID : 0 };
}

export function labelJson(label: Label): { id: number; name: string; color: string; description: string } {
  return { id: label.id, name: label.name, color: label.color, description: label.description };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.ownerLogin}/${repo.name}`,
    owner: userJson(repo.ownerLogin),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

export function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: userJson(issue.userLogin),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
  };
}

export function commentJson(comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.globalId,
    body: comment.body,
    user: userJson(comment.userLogin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

export function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headSha = pullHeadSha(repo, pr);
  const baseSha = pullBaseSha(repo, pr);
  return {
    id: pr.globalId,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: headSha, label: `${repo.ownerLogin}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: baseSha, label: `${repo.ownerLogin}:${pr.baseRef}` },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    user: userJson(pr.userLogin),
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
  };
}

/** The viewer object for GET /api/v3/user and GraphQL's viewer field. */
export function viewerJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' };
}

export function isValidOidString(value: string): boolean {
  return isOid(value);
}
