# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kapkopi/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kapkopi/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone one-process GitHub-compatible git forge: git smart HTTP (protocol v2 and v0), REST v3, GraphQL, and MCP, all served from its own git object store. Node 22, standard library only, no git binary, no install step.

## Run it

```sh
node main.ts
```

The trial harness sets MAKEFUN_ENV_URL; the process binds an ephemeral port, registers with the harness, and serves until the harness says the trial is done.

## What it serves

- Git smart HTTP at `/{owner}/{repo}.git` (upload-pack v2 and v0, receive-pack v0)
- REST v3 at `/api/v3` (repositories, issues, pull requests, contents, refs)
- GraphQL at `/api/graphql`
- MCP at `/mcp` (Streamable HTTP, JSON-RPC 2.0)

---

<sub>Entered on [make.fun](https://make.fun/?ref=n3ev77xf&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
