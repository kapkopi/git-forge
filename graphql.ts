// GraphQL at /api/graphql: a small hand-rolled executor for the eighteen fixed documents the
// conformance suite sends. It lexes and parses the query subset those documents use (operations,
// variables, aliases, inline input objects, inline fragments), pre-validates every field against
// a mini-schema before executing anything, and resolves against the same store REST and MCP use.
//
// Shapes the suite pins down:
// - one envelope per operation; a JSON array body answers with an array of envelopes, in order
// - an unknown field fails the whole operation: {data: null, errors: [{message}]} naming the field
// - a syntax error is HTTP 400; a missing token is HTTP 401; GraphQL failures are HTTP 200
// - global ids are opaque base64 ("Kind:<id>"), stable, and round-trip through node()

import {
  VIEWER_LOGIN,
  addIssueComment,
  addPullComment,
  branchTip,
  createIssue,
  createPull,
  decodeGlobalId,
  globalId,
  mergePull,
  patchIssue,
  pullFiles,
  pullMergeable,
  type Forge,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

export interface GraphqlContext {
  forge: Forge;
  method: string;
  body: Buffer;
  authorized: boolean;
}

export interface GraphqlResult {
  status: number;
  json: unknown;
}

// --------------------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string };

class SyntaxErrorMessage extends Error {}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  const isDigit = (ch: string): boolean => /[0-9]/.test(ch);
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
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
    if ('{}():!@$=[]|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') throw new SyntaxErrorMessage('block strings are not supported');
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= source.length) throw new SyntaxErrorMessage('unterminated string');
        const c = source[j]!;
        if (c === '"') break;
        if (c === '\n' || c === '\r') throw new SyntaxErrorMessage('newline in string');
        if (c === '\\') {
          const esc = source[j + 1];
          if (esc === undefined) throw new SyntaxErrorMessage('unterminated escape');
          if (esc === 'u') {
            const hex = source.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxErrorMessage('bad unicode escape');
            value += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
            continue;
          }
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          const mapped = simple[esc];
          if (mapped === undefined) throw new SyntaxErrorMessage('bad escape');
          value += mapped;
          j += 2;
          continue;
        }
        value += c;
        j += 1;
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '-' || isDigit(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      if (j >= source.length || !isDigit(source[j]!)) throw new SyntaxErrorMessage('bad number');
      while (j < source.length && isDigit(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && isDigit(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && isDigit(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        let k = j + 1;
        if (source[k] === '+' || source[k] === '-') k += 1;
        if (isDigit(source[k] ?? '')) {
          isFloat = true;
          j = k;
          while (j < source.length && isDigit(source[j]!)) j += 1;
        }
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    throw new SyntaxErrorMessage(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// --------------------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface ArgNode {
  name: string;
  value: ValueNode;
}

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: ArgNode[];
  selections?: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeName?: string;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface VariableDef {
  name: string;
  defaultValue?: ValueNode;
}

interface OperationNode {
  kind: 'query' | 'mutation';
  name?: string;
  variables: VariableDef[];
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new SyntaxErrorMessage('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new SyntaxErrorMessage(`expected "${value}"`);
    }
  }

  private eatPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new SyntaxErrorMessage(value === undefined ? 'expected a name' : `expected "${value}"`);
    }
    return token.value;
  }

  private peekName(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'name' && token.value === value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new SyntaxErrorMessage('empty document');
    return operations;
  }

  private parseOperation(): OperationNode {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '{') {
      return { kind: 'query', variables: [], selections: this.parseSelectionSet() };
    }
    const keyword = this.expectName();
    if (keyword !== 'query' && keyword !== 'mutation') {
      throw new SyntaxErrorMessage(`unsupported definition "${keyword}"`);
    }
    const operation: OperationNode = { kind: keyword, variables: [], selections: [] };
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName.kind === 'name') operation.name = this.expectName();
    if (this.eatPunct('(')) operation.variables = this.parseVariableDefs();
    this.rejectDirectives();
    operation.selections = this.parseSelectionSet();
    return operation;
  }

  private parseVariableDefs(): VariableDef[] {
    const defs: VariableDef[] = [];
    if (this.eatPunct(')')) return defs;
    for (;;) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      const def: VariableDef = { name };
      if (this.eatPunct('=')) def.defaultValue = this.parseValue();
      defs.push(def);
      if (this.eatPunct(')')) return defs;
    }
  }

  private parseType(): void {
    if (this.eatPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.eatPunct('!');
  }

  private rejectDirectives(): void {
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      throw new SyntaxErrorMessage('directives are not supported');
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new SyntaxErrorMessage('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.pos += 1;
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '...') {
      this.pos += 1;
      const fragment: FragmentNode = { kind: 'fragment', selections: [] };
      if (this.peekName('on')) {
        this.pos += 1;
        fragment.typeName = this.expectName();
      } else {
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') {
          throw new SyntaxErrorMessage('named fragment spreads are not supported');
        }
      }
      this.rejectDirectives();
      fragment.selections = this.parseSelectionSet();
      return fragment;
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.eatPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const field: FieldNode = { kind: 'field', name, args: [] };
    if (alias !== undefined) field.alias = alias;
    if (this.eatPunct('(')) field.args = this.parseArguments();
    this.rejectDirectives();
    const next = this.peek();
    if (next !== undefined && next.kind === 'punct' && next.value === '{') {
      field.selections = this.parseSelectionSet();
    }
    return field;
  }

  private parseArguments(): ArgNode[] {
    const args: ArgNode[] = [];
    if (this.eatPunct(')')) return args;
    for (;;) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
      if (this.eatPunct(')')) return args;
    }
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      if (this.eatPunct(']')) return { kind: 'list', values };
      for (;;) {
        values.push(this.parseValue());
        if (this.eatPunct(']')) return { kind: 'list', values };
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      if (this.eatPunct('}')) return { kind: 'object', fields };
      for (;;) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
        if (this.eatPunct('}')) return { kind: 'object', fields };
      }
    }
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new SyntaxErrorMessage('expected a value');
  }
}

// --------------------------------------------------------------------------- mini-schema

/** Field types: scalars (String/Int/Boolean/ID), object type names, or "[Type]" lists. */
const SCHEMA: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: { login: 'String' },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: 'String',
    hasIssuesEnabled: 'Boolean',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  Issue: { id: 'ID', number: 'Int', title: 'String', state: 'String', body: 'String' },
  IssueConnection: { nodes: '[Issue]', pageInfo: 'PageInfo' },
  PageInfo: { hasNextPage: 'Boolean', endCursor: 'String' },
  PullRequest: {
    id: 'ID',
    number: 'Int',
    state: 'String',
    merged: 'Boolean',
    headRefName: 'String',
    baseRefName: 'String',
    mergeable: 'String',
    files: 'PullRequestChangedFileConnection',
  },
  PullRequestConnection: { nodes: '[PullRequest]' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', pageInfo: 'PageInfo' },
  PullRequestChangedFile: { path: 'String' },
  Ref: { name: 'String' },
  Node: { id: 'ID' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  IssueComment: { id: 'ID', body: 'String' },
  __Type: { name: 'String', fields: '[__Field]', enumValues: '[__EnumValue]' },
  __Field: { name: 'String' },
  __EnumValue: { name: 'String' },
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'REGISTRY_PACKAGE', 'MARKETPLACE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
};

const SCALARS = new Set(['String', 'Int', 'Boolean', 'ID']);

function unwrapList(type: string): string {
  return type.startsWith('[') && type.endsWith(']') ? type.slice(1, -1) : type;
}

class ValidationFailure extends Error {}

/** Pre-validate the whole document: the first unknown field fails the operation. */
function validateOperation(operation: OperationNode): void {
  validateSelections(operation.selections, operation.kind === 'query' ? 'Query' : 'Mutation');
}

function validateSelections(selections: readonly SelectionNode[], parentType: string): void {
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const fragmentType = selection.typeName ?? parentType;
      if (SCHEMA[fragmentType] === undefined) throw new ValidationFailure(`Unknown type "${fragmentType}".`);
      validateSelections(selection.selections, fragmentType);
      continue;
    }
    if (selection.name === '__typename') {
      if (selection.selections !== undefined) throw new ValidationFailure('Field "__typename" must not have a selection since type "String" has no subfields.');
      continue;
    }
    const fields = SCHEMA[parentType];
    const fieldType = fields?.[selection.name];
    if (fieldType === undefined) {
      throw new ValidationFailure(`Cannot query field "${selection.name}" on type "${parentType}".`);
    }
    const named = unwrapList(fieldType);
    if (SCALARS.has(named)) {
      if (selection.selections !== undefined) {
        throw new ValidationFailure(`Field "${selection.name}" must not have a selection since type "${named}" has no subfields.`);
      }
    } else {
      if (selection.selections === undefined) {
        throw new ValidationFailure(`Field "${selection.name}" of type "${fieldType}" must have a selection of subfields.`);
      }
      validateSelections(selection.selections, named);
    }
  }
}

// --------------------------------------------------------------------------- values and cursors

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return node.name in variables ? variables[node.name] : null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => resolveValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, variables);
  return args;
}

function encodeCursor(marker: string): string {
  return Buffer.from(`cursor:${marker}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): string | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    if (Buffer.from(text, 'utf8').toString('base64') !== cursor) return null;
    return text.slice('cursor:'.length);
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- execution

/** A resolved object value: its concrete type, its Relay id when node-able, and its data. */
interface Wrapped {
  __typename: string;
  __globalId?: string;
  value: unknown;
}

function wrap(typename: string, value: unknown, id?: string): Wrapped {
  const wrapped: Wrapped = { __typename: typename, value };
  if (id !== undefined) wrapped.__globalId = id;
  return wrapped;
}

class FieldFailure extends Error {}

interface Executor {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function executeOperation(operation: OperationNode, forge: Forge, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const executor: Executor = { forge, variables, errors: [] };
  const rootType = operation.kind === 'query' ? 'Query' : 'Mutation';
  const data = executeSelections(operation.selections, rootType, wrap(rootType, {}), executor);
  if (executor.errors.length > 0) return { data, errors: executor.errors };
  return { data };
}

function executeSelections(
  selections: readonly SelectionNode[],
  parentType: string,
  parent: Wrapped,
  executor: Executor,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const fragmentType = selection.typeName;
      const applies =
        fragmentType === undefined ||
        fragmentType === parent.__typename ||
        (fragmentType === 'Node' && (parent.__typename === 'Repository' || parent.__typename === 'Issue' || parent.__typename === 'PullRequest'));
      if (!applies) continue;
      Object.assign(out, executeSelections(selection.selections, fragmentType ?? parentType, parent, executor));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = parent.__typename;
      continue;
    }
    let resolved: unknown;
    try {
      resolved = resolveField(parentType, parent, selection, executor);
    } catch (error) {
      if (error instanceof FieldFailure) {
        executor.errors.push({ message: error.message });
        out[key] = null;
        continue;
      }
      throw error;
    }
    if (resolved === null || resolved === undefined) {
      out[key] = null;
      continue;
    }
    if (selection.selections === undefined) {
      out[key] = resolved;
      continue;
    }
    const fieldType = SCHEMA[parentType]?.[selection.name] ?? '';
    const named = unwrapList(fieldType);
    if (Array.isArray(resolved)) {
      out[key] = resolved.map((item) => (item === null ? null : executeSelections(selection.selections!, named, item as Wrapped, executor)));
    } else {
      out[key] = executeSelections(selection.selections, named, resolved as Wrapped, executor);
    }
  }
  return out;
}

function asStringArg(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asIntArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prState(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function wrapIssue(issue: Issue): Wrapped {
  return wrap('Issue', issue, globalId('Issue', issue.globalId));
}

function wrapPr(repo: Repo, pr: PullRequest): Wrapped {
  return wrap('PullRequest', { repo, pr }, globalId('PullRequest', pr.globalId));
}

function wrapRepo(repo: Repo): Wrapped {
  return wrap('Repository', repo, globalId('Repository', repo.id));
}

function resolveField(parentType: string, parent: Wrapped, field: FieldNode, executor: Executor): unknown {
  const { forge } = executor;
  const args = resolveArgs(field, executor.variables);

  if (parentType === 'Query') {
    if (field.name === 'viewer') return wrap('User', { login: VIEWER_LOGIN });
    if (field.name === 'repository') {
      const owner = asStringArg(args.owner);
      const name = asStringArg(args.name);
      if (owner === undefined || name === undefined) return null;
      const repo = forge.getRepo(owner, name);
      return repo === undefined ? null : wrapRepo(repo);
    }
    if (field.name === 'node') {
      const id = asStringArg(args.id);
      if (id === undefined) return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = forge.repoById.get(decoded.id);
        return repo === undefined ? null : wrapRepo(repo);
      }
      if (decoded.kind === 'Issue') {
        const found = forge.issueByGlobal.get(decoded.id);
        return found === undefined ? null : wrapIssue(found.issue);
      }
      if (decoded.kind === 'PullRequest') {
        const found = forge.prByGlobal.get(decoded.id);
        return found === undefined ? null : wrapPr(found.repo, found.pr);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = asStringArg(args.name);
      if (name === undefined) return null;
      if (SCHEMA[name] === undefined && ENUM_VALUES[name] === undefined) return null;
      return wrap('__Type', { typeName: name });
    }
  }

  if (parentType === 'Node' && field.name === 'id') {
    return parent.__globalId ?? null;
  }

  if (parentType === 'User' && field.name === 'login') {
    return (parent.value as { login: string }).login;
  }

  if (parentType === 'Repository') {
    const repo = parent.value as Repo;
    switch (field.name) {
      case 'id':
        return globalId('Repository', repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.ownerLogin}/${repo.name}`;
      case 'owner':
        return wrap('User', { login: repo.ownerLogin });
      case 'defaultBranchRef': {
        const tip = branchTip(repo, repo.defaultBranch);
        return tip === undefined ? null : wrap('Ref', { name: repo.defaultBranch });
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const number = asIntArg(args.number);
        if (number === undefined) return null;
        const issue = repo.issues.get(number);
        return issue === undefined ? null : wrapIssue(issue);
      }
      case 'issues':
        return issuesConnection(repo, args);
      case 'pullRequests': {
        const first = asIntArg(args.first);
        let pulls = [...repo.pulls.values()].filter((pr) => pr.state === 'open');
        pulls.sort((a, b) => a.number - b.number);
        if (first !== undefined) pulls = pulls.slice(0, first);
        return wrap('PullRequestConnection', { nodes: pulls.map((pr) => wrapPr(repo, pr)) });
      }
      case 'pullRequest': {
        const number = asIntArg(args.number);
        if (number === undefined) return null;
        const pr = repo.pulls.get(number);
        return pr === undefined ? null : wrapPr(repo, pr);
      }
    }
  }

  if (parentType === 'Issue') {
    const issue = parent.value as Issue;
    switch (field.name) {
      case 'id':
        return globalId('Issue', issue.globalId);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issueState(issue);
      case 'body':
        return issue.body;
    }
  }

  if (parentType === 'IssueConnection') {
    const connection = parent.value as { nodes: Wrapped[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    if (field.name === 'nodes') return connection.nodes;
    if (field.name === 'pageInfo') return wrap('PageInfo', connection.pageInfo);
  }

  if (parentType === 'PageInfo') {
    const pageInfo = parent.value as { hasNextPage: boolean; endCursor: string | null };
    if (field.name === 'hasNextPage') return pageInfo.hasNextPage;
    if (field.name === 'endCursor') return pageInfo.endCursor;
  }

  if (parentType === 'PullRequest') {
    const { repo, pr } = parent.value as { repo: Repo; pr: PullRequest };
    switch (field.name) {
      case 'id':
        return globalId('PullRequest', pr.globalId);
      case 'number':
        return pr.number;
      case 'state':
        return prState(pr);
      case 'merged':
        return pr.merged;
      case 'headRefName':
        return pr.headRef;
      case 'baseRefName':
        return pr.baseRef;
      case 'mergeable':
        return pullMergeable(repo, pr);
      case 'files': {
        const first = asIntArg(args.first);
        const files = pullFiles(repo, pr);
        const page = first === undefined ? files : files.slice(0, first);
        const hasNextPage = page.length < files.length;
        const endCursor = page.length === 0 ? null : encodeCursor(page[page.length - 1]!.filename);
        return wrap('PullRequestChangedFileConnection', {
          nodes: page.map((file) => wrap('PullRequestChangedFile', { path: file.filename })),
          pageInfo: { hasNextPage, endCursor },
        });
      }
    }
  }

  if (parentType === 'PullRequestConnection') {
    const connection = parent.value as { nodes: Wrapped[] };
    if (field.name === 'nodes') return connection.nodes;
  }

  if (parentType === 'PullRequestChangedFileConnection') {
    const connection = parent.value as { nodes: Wrapped[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    if (field.name === 'nodes') return connection.nodes;
    if (field.name === 'pageInfo') return wrap('PageInfo', connection.pageInfo);
  }

  if (parentType === 'PullRequestChangedFile' && field.name === 'path') {
    return (parent.value as { path: string }).path;
  }

  if (parentType === 'Ref' && field.name === 'name') {
    return (parent.value as { name: string }).name;
  }

  if (parentType === '__Type') {
    const { typeName } = parent.value as { typeName: string };
    if (field.name === 'name') return typeName;
    if (field.name === 'fields') {
      const fields = SCHEMA[typeName];
      if (fields === undefined) return [];
      return Object.keys(fields).map((name) => wrap('__Field', { name }));
    }
    if (field.name === 'enumValues') {
      const values = ENUM_VALUES[typeName];
      if (values === undefined) return [];
      return values.map((name) => wrap('__EnumValue', { name }));
    }
  }

  if ((parentType === '__Field' || parentType === '__EnumValue') && field.name === 'name') {
    return (parent.value as { name: string }).name;
  }

  if (parentType === 'Mutation') {
    return resolveMutation(field, args, executor);
  }

  if (parentType === 'CreateIssuePayload' || parentType === 'CloseIssuePayload') {
    const payload = parent.value as { issue: Issue | null };
    if (field.name === 'issue') return payload.issue === null ? null : wrapIssue(payload.issue);
  }

  if (parentType === 'CreatePullRequestPayload' || parentType === 'MergePullRequestPayload') {
    const payload = parent.value as { repo: Repo; pr: PullRequest | null };
    if (field.name === 'pullRequest') return payload.pr === null ? null : wrapPr(payload.repo, payload.pr);
  }

  if (parentType === 'AddCommentPayload') {
    const payload = parent.value as { comment: { globalId: number; body: string } | null };
    if (field.name === 'commentEdge') {
      return payload.comment === null ? null : wrap('IssueCommentEdge', { node: payload.comment });
    }
  }

  if (parentType === 'IssueCommentEdge' && field.name === 'node') {
    const edge = parent.value as { node: { globalId: number; body: string } };
    return wrap('IssueComment', edge.node, globalId('IssueComment', edge.node.globalId));
  }

  if (parentType === 'IssueComment') {
    const comment = parent.value as { globalId: number; body: string };
    if (field.name === 'id') return globalId('IssueComment', comment.globalId);
    if (field.name === 'body') return comment.body;
  }

  throw new FieldFailure(`Cannot resolve field "${field.name}" on type "${parentType}".`);
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Wrapped {
  const states = Array.isArray(args.states) ? (args.states as unknown[]).filter((s): s is string => typeof s === 'string') : undefined;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const orderField = asStringArg(orderBy.field) ?? 'CREATED_AT';
  const direction = asStringArg(orderBy.direction) ?? 'ASC';
  const first = asIntArg(args.first);
  const after = args.after;

  let issues = [...repo.issues.values()];
  if (states !== undefined) {
    issues = issues.filter((issue) => states.includes(issueState(issue)));
  }
  const sign = direction === 'DESC' ? -1 : 1;
  issues.sort((a, b) => {
    let cmp: number;
    if (orderField === 'UPDATED_AT') cmp = a.updatedSeq - b.updatedSeq;
    else if (orderField === 'COMMENTS') cmp = a.comments.length - b.comments.length;
    else cmp = a.seq - b.seq;
    if (cmp === 0) cmp = a.number - b.number;
    return cmp * sign;
  });

  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const marker = decodeCursor(after);
    if (marker !== null) {
      const number = Number(marker);
      const index = issues.findIndex((issue) => issue.number === number);
      if (index >= 0) start = index + 1;
    }
  }
  const page = first === undefined ? issues.slice(start) : issues.slice(start, start + first);
  const hasNextPage = start + page.length < issues.length;
  const endCursor = page.length === 0 ? null : encodeCursor(String(page[page.length - 1]!.number));
  return wrap('IssueConnection', {
    nodes: page.map(wrapIssue),
    pageInfo: { hasNextPage, endCursor },
  });
}

function resolveMutation(field: FieldNode, args: Record<string, unknown>, executor: Executor): unknown {
  const { forge } = executor;
  // The suite's mutations take one `input:` object (GitHub's input shapes); flat arguments are
  // accepted too, so either spelling resolves the same fields.
  const input = (args.input !== null && typeof args.input === 'object' && !Array.isArray(args.input) ? args.input : args) as Record<string, unknown>;

  if (field.name === 'createIssue') {
    const repositoryId = asStringArg(input.repositoryId);
    const title = asStringArg(input.title) ?? '';
    const body = asStringArg(input.body) ?? '';
    const decoded = repositoryId === undefined ? null : decodeGlobalId(repositoryId);
    const repo = decoded !== null && decoded.kind === 'Repository' ? forge.repoById.get(decoded.id) : undefined;
    if (repo === undefined) return wrap('CreateIssuePayload', { issue: null });
    const created = createIssue(forge, repo, { title, body, labelNames: [] });
    return wrap('CreateIssuePayload', { issue: created.ok ? created.issue : null });
  }

  if (field.name === 'closeIssue') {
    const issueId = asStringArg(input.issueId);
    const decoded = issueId === undefined ? null : decodeGlobalId(issueId);
    const found = decoded !== null && decoded.kind === 'Issue' ? forge.issueByGlobal.get(decoded.id) : undefined;
    if (found === undefined) return wrap('CloseIssuePayload', { issue: null });
    const closed = patchIssue(forge, found.repo, found.issue.number, { state: 'closed' });
    return wrap('CloseIssuePayload', { issue: closed ?? null });
  }

  if (field.name === 'createPullRequest') {
    const repositoryId = asStringArg(input.repositoryId);
    const baseRefName = asStringArg(input.baseRefName);
    const headRefName = asStringArg(input.headRefName);
    const title = asStringArg(input.title) ?? '';
    const decoded = repositoryId === undefined ? null : decodeGlobalId(repositoryId);
    const repo = decoded !== null && decoded.kind === 'Repository' ? forge.repoById.get(decoded.id) : undefined;
    if (repo === undefined || baseRefName === undefined || headRefName === undefined) {
      return wrap('CreatePullRequestPayload', { repo: repo as Repo | undefined, pr: null });
    }
    const created = createPull(forge, repo, { head: headRefName, base: baseRefName, title, body: '' });
    return wrap('CreatePullRequestPayload', { repo, pr: created.ok ? created.pr : null });
  }

  if (field.name === 'mergePullRequest') {
    const pullRequestId = asStringArg(input.pullRequestId);
    const decoded = pullRequestId === undefined ? null : decodeGlobalId(pullRequestId);
    const found = decoded !== null && decoded.kind === 'PullRequest' ? forge.prByGlobal.get(decoded.id) : undefined;
    if (found === undefined) throw new FieldFailure('Pull request not found');
    const merged = mergePull(forge, found.repo, found.pr);
    if (!merged.ok) {
      if (merged.error === 'conflict') throw new FieldFailure('Merge conflict: the pull request cannot be merged cleanly');
      throw new FieldFailure('The pull request cannot be merged');
    }
    return wrap('MergePullRequestPayload', { repo: found.repo, pr: found.pr });
  }

  if (field.name === 'addComment') {
    const subjectId = asStringArg(input.subjectId);
    const body = asStringArg(input.body) ?? '';
    const decoded = subjectId === undefined ? null : decodeGlobalId(subjectId);
    if (decoded !== null && decoded.kind === 'Issue') {
      const found = forge.issueByGlobal.get(decoded.id);
      if (found !== undefined) {
        const comment = addIssueComment(forge, found.repo, found.issue, body);
        return wrap('AddCommentPayload', { comment });
      }
    }
    if (decoded !== null && decoded.kind === 'PullRequest') {
      const found = forge.prByGlobal.get(decoded.id);
      if (found !== undefined) {
        const comment = addPullComment(forge, found.pr, body);
        return wrap('AddCommentPayload', { comment });
      }
    }
    return wrap('AddCommentPayload', { comment: null });
  }

  throw new FieldFailure(`Unknown mutation "${field.name}".`);
}

// --------------------------------------------------------------------------- top level

interface GraphqlRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeRequest(request: GraphqlRequest, forge: Forge): { envelope: Record<string, unknown>; syntaxError: boolean } {
  const query = request.query;
  if (typeof query !== 'string' || query === '') {
    return { envelope: { errors: [{ message: 'Must provide a query string.' }] }, syntaxError: true };
  }
  let operations: OperationNode[];
  try {
    operations = new Parser(lex(query)).parseDocument();
  } catch (error) {
    if (error instanceof SyntaxErrorMessage) {
      return { envelope: { errors: [{ message: error.message }] }, syntaxError: true };
    }
    throw error;
  }
  let operation: OperationNode | undefined;
  const operationName = typeof request.operationName === 'string' ? request.operationName : undefined;
  if (operations.length === 1) {
    operation = operations[0];
  } else if (operationName !== undefined) {
    operation = operations.find((candidate) => candidate.name === operationName);
  }
  if (operation === undefined) {
    return { envelope: { errors: [{ message: 'Must provide an operation name for a multi-operation document.' }] }, syntaxError: false };
  }
  const rawVariables = request.variables;
  const variables: Record<string, unknown> =
    rawVariables !== null && typeof rawVariables === 'object' && !Array.isArray(rawVariables)
      ? { ...(rawVariables as Record<string, unknown>) }
      : {};
  for (const def of operation.variables) {
    if (!(def.name in variables) && def.defaultValue !== undefined) {
      variables[def.name] = resolveValue(def.defaultValue, variables);
    }
    if (!(def.name in variables)) variables[def.name] = null;
  }
  try {
    validateOperation(operation);
  } catch (error) {
    if (error instanceof ValidationFailure) {
      return { envelope: { data: null, errors: [{ message: error.message }] }, syntaxError: false };
    }
    throw error;
  }
  try {
    const result = executeOperation(operation, forge, variables);
    const envelope: Record<string, unknown> = { data: result.data };
    if (result.errors !== undefined) envelope.errors = result.errors;
    return { envelope, syntaxError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { envelope: { data: null, errors: [{ message }] }, syntaxError: false };
  }
}

export function handleGraphql(ctx: GraphqlContext): GraphqlResult {
  if (!ctx.authorized) {
    return { status: 401, json: { errors: [{ message: 'Unauthorized' }] } };
  }
  if (ctx.method !== 'POST') {
    return { status: 405, json: { errors: [{ message: 'Method not allowed' }] } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return { status: 400, json: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    const envelopes = parsed.map((item) => {
      const request = (item ?? {}) as GraphqlRequest;
      return executeRequest(request, ctx.forge).envelope;
    });
    return { status: 200, json: envelopes };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 400, json: { errors: [{ message: 'Must provide a query string.' }] } };
  }
  const { envelope, syntaxError } = executeRequest(parsed as GraphqlRequest, ctx.forge);
  return { status: syntaxError ? 400 : 200, json: envelope };
}
