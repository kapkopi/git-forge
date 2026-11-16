// MCP: JSON-RPC 2.0 over Streamable HTTP at /mcp, stateless, plain JSON replies (no SSE).
// The six tools share the store and the logic with REST, so a repository created here reads back
// identically over REST and GraphQL. The tools list is a frozen constant: the suite compares two
// listings byte for byte.

import {
  VIEWER_LOGIN,
  createIssue,
  createPull,
  issueJson,
  listIssues,
  mergePull,
  pullJson,
  repoJson,
  type Forge,
} from './store.ts';

export interface McpContext {
  forge: Forge;
  method: string;
  body: Buffer;
  authorized: boolean;
}

export interface McpResult {
  status: number;
  json?: unknown;
  empty?: boolean;
}

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const DISCOVER_RESULT = {
  supportedVersions: SUPPORTED_VERSIONS,
  capabilities: { tools: {} },
  serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  instructions: 'A GitHub-compatible forge: repositories, issues, and pull requests over MCP tools.',
  _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
};

/** The frozen tool list: exactly six tools, canonical names, no extra annotations. */
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
        owner: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue on a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues on a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type JsonRpcId = string | number | null;

function resultEnvelope(id: JsonRpcId, result: unknown): McpResult {
  return { status: 200, json: { jsonrpc: '2.0', id, result } };
}

function errorEnvelope(id: JsonRpcId, code: number, message: string): McpResult {
  return { status: 200, json: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolResult(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

function stripForkPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

/**
 * Resolve owner/repo from the arguments, tolerating a full_name ("owner/repo") spelling when the
 * separate fields are missing. Returns null when neither spelling is usable.
 */
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const owner = asString(args.owner);
  const repo = asString(args.repo);
  if (owner !== undefined && repo !== undefined) return { owner, repo };
  const fullName = asString(args.full_name);
  if (fullName !== undefined) {
    const slash = fullName.indexOf('/');
    if (slash > 0 && slash < fullName.length - 1) {
      return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
    }
  }
  return null;
}

export function handleMcp(ctx: McpContext): McpResult {
  // Auth comes first, before the body is even parsed: every /mcp request, discover included.
  if (!ctx.authorized) {
    return { status: 401, json: { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } } };
  }
  if (ctx.method !== 'POST') {
    return { status: 405, json: { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } } };
  }

  let request: unknown;
  try {
    request = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return errorEnvelope(null, -32600, 'Invalid Request');
  }
  const message = request as Record<string, unknown>;
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  if (!hasId) {
    // A notification (no id): acknowledge and stay silent. This covers notifications/initialized.
    return { status: 202, empty: true };
  }
  const id = (message.id as JsonRpcId) ?? null;
  const method = message.method;
  if (typeof method !== 'string' || method === '') {
    return errorEnvelope(id, -32600, 'Invalid Request');
  }
  const params = asRecord(message.params);

  if (method === 'server/discover') {
    return resultEnvelope(id, DISCOVER_RESULT);
  }
  if (method === 'initialize') {
    const offered = asString(params.protocolVersion);
    const protocolVersion = offered !== undefined && SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return resultEnvelope(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return resultEnvelope(id, {});
  }
  if (method === 'tools/list') {
    return resultEnvelope(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    return handleToolsCall(ctx.forge, id, params);
  }
  return errorEnvelope(id, -32601, `Method not found: ${method}`);
}

function handleToolsCall(forge: Forge, id: JsonRpcId, params: Record<string, unknown>): McpResult {
  const name = asString(params.name);
  if (name === undefined || name === '') {
    return errorEnvelope(id, -32602, 'Missing required argument: name');
  }
  const args = asRecord(params.arguments);
  const known = TOOLS.some((tool) => tool.name === name);
  if (!known) {
    return errorEnvelope(id, -32601, `Unknown tool: ${name}`);
  }

  const missing = (field: string): McpResult => errorEnvelope(id, -32602, `Missing required argument: ${field}`);

  if (name === 'create_repo') {
    const repoName = asString(args.name);
    if (repoName === undefined || repoName === '') return missing('name');
    const repo = forge.createRepo(repoName, asBoolean(args.private) ?? false, asString(args.description) ?? '');
    if (repo === null) {
      return resultEnvelope(id, toolError(`Repository "${VIEWER_LOGIN}/${repoName}" already exists`));
    }
    return resultEnvelope(id, toolResult(repoJson(repo)));
  }

  const target = ownerRepo(args);
  if (target === null) return missing('owner');
  const repo = forge.getRepo(target.owner, target.repo);
  if (repo === undefined) {
    return resultEnvelope(id, toolError(`Repository "${target.owner}/${target.repo}" not found`));
  }

  if (name === 'get_repo') {
    return resultEnvelope(id, toolResult(repoJson(repo)));
  }
  if (name === 'create_issue') {
    const title = asString(args.title);
    if (title === undefined || title === '') return missing('title');
    const created = createIssue(forge, repo, { title, body: asString(args.body) ?? '', labelNames: [] });
    if (!created.ok) return resultEnvelope(id, toolError(`Label "${created.label}" does not exist`));
    return resultEnvelope(id, toolResult(issueJson(created.issue)));
  }
  if (name === 'list_issues') {
    const state = asString(args.state) ?? 'open';
    const issues = listIssues(repo, { state });
    return resultEnvelope(id, toolResult(issues.map(issueJson)));
  }
  if (name === 'create_pull_request') {
    const title = asString(args.title);
    if (title === undefined || title === '') return missing('title');
    const head = asString(args.head);
    if (head === undefined || head === '') return missing('head');
    const base = asString(args.base);
    if (base === undefined || base === '') return missing('base');
    const created = createPull(forge, repo, {
      head: stripForkPrefix(head),
      base: stripForkPrefix(base),
      title,
      body: asString(args.body) ?? '',
    });
    if (!created.ok) return resultEnvelope(id, toolError('head or base branch does not exist'));
    return resultEnvelope(id, toolResult(pullJson(repo, created.pr)));
  }
  if (name === 'merge_pull_request') {
    const pullNumber = asInteger(args.pull_number);
    if (pullNumber === undefined) return missing('pull_number');
    const pr = repo.pulls.get(pullNumber);
    if (pr === undefined) return resultEnvelope(id, toolError(`Pull request #${pullNumber} not found`));
    const merged = mergePull(forge, repo, pr);
    if (!merged.ok) {
      if (merged.error === 'conflict') return resultEnvelope(id, toolError('Merge conflict: the pull request cannot be merged cleanly'));
      if (merged.error === 'already-merged') return resultEnvelope(id, toolError('Pull request has already been merged'));
      return resultEnvelope(id, toolError('The pull request cannot be merged'));
    }
    return resultEnvelope(id, toolResult({ merged: true, sha: merged.sha, message: 'Pull request successfully merged' }));
  }

  return errorEnvelope(id, -32601, `Unknown tool: ${name}`);
}
