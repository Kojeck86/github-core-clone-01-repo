# github-core-clone-01-forge

A GitHub-compatible git forge, built for the make.fun bounty
**github-core-clone-01** ("Build a GitHub-compatible git forge").
One process, one in-memory store, no UI, no outside service, no git
binary anywhere: the git protocol, the REST API, GraphQL and MCP are
all implemented from scratch on the Node standard library.

## What it serves

- **Git smart HTTP** — `/<owner>/<repo>.git/info/refs`,
  `git-upload-pack` (protocol v2 and v0) and `git-receive-pack` (v0),
  with a hand-written pkt-line codec, packfile reader/writer
  (v2/v3, OFS and REF deltas), and a SHA-1 object store on
  `node:zlib` + `node:crypto`. Real git clients can clone, fetch
  (including shallow `--depth` / `--deepen`), push, create and delete
  branches and tags, and read annotated tags byte-exactly.
- **REST v3** under `/api/v3` — repositories, branches, commits and
  contents; issues, comments and labels; pull requests, their files
  and squash merges; pagination with `Link: rel="next"`, the
  `X-GitHub-Request-Id` header on every reply, and Bearer-token auth
  (missing or wrong token → 401).
- **GraphQL** at `POST /api/graphql` — viewer, repository, issues and
  pull requests (including `__type` introspection, `node(id:)`, Relay
  global ids, cursor pagination, batched documents, and the five
  mutations `createIssue`, `closeIssue`, `createPullRequest`,
  `mergePullRequest`, `addComment`).
- **MCP** at `POST /mcp` — streamable HTTP JSON-RPC 2.0:
  `server/discover`, legacy `initialize`, `tools/list` (six tools) and
  `tools/call`. Tool effects are the same objects the REST view reads.

## Determinism

The forge keeps no clock in its state: ordering comes from monotonic
counters, and every commit the forge itself writes uses a fixed epoch
(plus one second per commit). Two runs on the same instance leave the
same state export byte for byte.

## Running it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entrypoint: it binds an ephemeral port (never 8080),
registers it with `$MAKEFUN_ENV_URL`, polls `GET $MAKEFUN_ENV_URL/done`
until the env says the trial is over, then exits 0. Without
`MAKEFUN_ENV_URL` it exits 1 at once. `app.ts` builds the HTTP server;
the modules under `src/` are the forge itself:

| file | contents |
| --- | --- |
| `src/gitcore.ts` | pkt-line codec, SHA-1 objects, trees/commits/tags, pack read/write, reachability |
| `src/store.ts` | the in-memory forge: repos, objects, refs, issues, pull requests |
| `src/diffmerge.ts` | tree diffs (line counts) and three-way merges |
| `src/githttp.ts` | smart-HTTP handlers (info/refs, upload-pack, receive-pack) |
| `src/rest.ts` | REST v3 handlers |
| `src/graphql.ts` | GraphQL lexer, parser and executor |
| `src/mcp.ts` | MCP JSON-RPC handlers |

Node 22 or newer, standard library only, nothing to install.

## Local grading

From the kit directory (the kit is not part of this repo):

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> \
  --driver process --instances 3 --worktree
```

Practice trials 0–2 (2026-11-14): **120/120 conformance checks
pass on every trial** — git 30/30, repos 15/15, issues 15/15,
pulls 20/20, GraphQL 20/20, MCP 15/15, protocol 5/5 —
with local scores of **974, 974 and ~976 / 1000**
(feature 600, agent 200, perf ~174–176).

## License

MIT — see `LICENSE`.
