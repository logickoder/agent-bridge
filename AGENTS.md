# agent-bridge: working on this repo

## Layout

| Path | Role |
|---|---|
| `src/cli.ts` | Entry. Core commands, then adapter commands from the registry |
| `src/install.ts` | Links `agent-bridge`, then runs each adapter's install or uninstall |
| `src/paths.ts` | State locations (`~/.agent-bridge`) and `ensureHome` |
| `src/schema.ts` | Zod schemas for every boundary: socket requests and replies, messages, peers |
| `src/names.ts` | Auto peer names: `<folder>-<kind>` base, next free suffix. Pure |
| `src/format.ts` | Send results, shared by the tools and the CLI. Agent-specific wording lives in the adapter (`agy/format.ts`) |
| `src/daemon/hub.ts` | Routing state machine. Pure apart from an injected `Store`. All delivery and binding rules live here |
| `src/daemon/server.ts` | Unix socket server around `Hub` |
| `src/daemon/lock.ts` | Single-instance lock: atomic create, stale takeover |
| `src/daemon/store.ts` | Disk persistence for peers and queues. A corrupt file is moved aside |
| `src/client/index.ts` | Connect (starting the daemon when needed), request/reply, held listen with reconnect, `stopDaemon` |
| `src/mcp/identity.ts` | Server name and version. Tiny, so adapter indexes can import it |
| `src/mcp/server.ts` | Minimal MCP stdio server and `defineTool` (zod args to JSON schema) |
| `src/mcp/tools.ts` | The `send` and `peers` tools, shared by every agent kind |
| `src/net/` | Networks across machines. Pure: `crypto`, `channel`, `envelope`, `invite`, `handshake`, `directory`, `url-update`, `relay` (host state machine), `link` (a member's side), `format`, `schema`. I/O: `store` (files under `net/`, 0600), `http-server`, `transport-http`, `transport-local` (the host's own member), `keeper` (holds the port, relays to the daemon's socket, runs a trial cloudflared), `service` (daemon wiring, answers `op: 'net'`), `cli` (`agent-bridge net`) |
| `src/lib/` | Generic helpers, no bridge logic: `errors` (errno codes, `toError`, `isDaemonDown`), `json-file` (validated read, atomic write, `readJsonDir`), `log` (tagged stderr), `wire` (JSON lines), `args`, `config` (other tools' config and PATH links), `rate` (token bucket), `tty` (ask on a terminal; undefined without one) |
| `src/adapters/types.ts` | The `Adapter` interface every agent kind implements |
| `src/adapters/index.ts` | `ADAPTERS` registry, typed `Record<PeerKind, Adapter>` |
| `src/adapters/<kind>/` | Everything agent-specific. `index.ts` exports the adapter and is the folder's only entry point. The rest is split by concern: `mcp.ts`, `install.ts`, `names.ts` (constants), and the wake path (`agy/push.ts`, `agy/listen.ts`, `agy/hook.ts`, `agy/format.ts`, `claude/socket.ts`, `claude/monitor.ts`, `claude/format.ts`, `claude/channel/`) |
| `src/adapters/agy/skill/` | The Antigravity `/bridge` skill, copied by install |
| `src/adapters/opencode/plugin/` | The opencode plugin. Standalone (node built-ins only): install copies the built file into opencode's plugins folder |
| `src/adapters/claude/plugin/` | The Claude plugin: `/bridge` (socket) and `/bridge-monitor` skills sharing `shared/peer-messages.md`, the monitor, and the bypass-guard hook. Registered by install through the repo's `.claude-plugin/marketplace.json` |
| `docs/` | User docs (`concepts.md`, `install.md`, `agents/`) and the design record (`decisions.md`, `live-tests.md`, `adding-an-agent.md`, `open-questions.md`). Agent findings live in `docs/agents/<agent>.md`; never name a file there `claude.md`, macOS loads it as `CLAUDE.md` |
| `landing/` | The product page at logickoder.dev/agent-bridge. Its own Vite + React + Tailwind project with its own lockfile, deployed by `.github/workflows/site.yml`. Reads the version from the root `package.json`. The favicon and social card are served from `docs/assets` by a plugin in `landing/vite.config.ts`; edit them in `docs/assets`. `vite build` prerenders the page into `index.html` (`buildApp` in `landing/vite.config.ts`, rendering `landing/src/entry-server.tsx`); title, meta and JSON-LD come from `SEO` there, so components must not touch `window` or `document` while rendering. Not part of the npm package |
| `test/` | Tests that touch real files, sockets or processes. `e2e.test.ts` runs against `dist/cli.js`. `net*.test.ts` run several homes as separate users through `harness.ts` (homes, `until`, `socketRequest`, `tty` on a pseudo-terminal), with `proxy.ts` (a recording, tampering stand-in for the tunnel) |

## Rules

- Gate: `pnpm check` (typecheck, unit, e2e) before calling work done.
- Unit tests sit next to the unit (`*.test.ts`) and do no I/O. Anything that spawns processes or opens sockets goes in `test/`.
- e2e waits on conditions (`until`, `online`), never on fixed sleeps. Fixed sleeps flaked under load.
- An adapter's `index.ts` loads its other modules with `await import()` inside each member. `agy-hook` runs on every Antigravity model call and must not load install, MCP or the other adapters.
- Shared code (`mcp/tools.ts`, `format.ts`, `daemon/`) never names an agent kind, command or default name. Pass such text in from the adapter (`bridgeTools({ asHelp })`).
- Import an adapter only through its `index.ts`. Files inside an adapter folder do not import from other adapters.
- Use `src/lib/` for errno checks, JSON files, logging and JSON lines. Do not hand-roll them in a module. Logs go to stderr only: stdout carries MCP and hook output.
- Validate everything that crosses a process boundary with the schemas in `src/schema.ts`.
- Message text never goes on a command line that a shell parses. Agent hints use `sendHeredoc` in `src/format.ts` (text on stdin, quoted heredoc, a random end marker per hint or from `agent-bridge marker`; never a fixed or agent-made marker). Tests for send paths an agent runs through a shell go through a real `sh -c`, not only an argv array (opencode's tool passes argv and stdin, with no shell).
- New agent kind: add it to `PEER_KINDS`, create `src/adapters/<kind>/` with an `index.ts` exporting the `Adapter`, register it in `ADAPTERS`, add e2e coverage. See `docs/adding-an-agent.md`. Never branch on kind outside `src/adapters/`.
- Never ship an Antigravity PreToolUse hook that returns `{}` for calls it does not mean to gate. Antigravity treats `{}` as deny (`docs/agents/antigravity.md`, finding 5).
- After changing `src/`, run `pnpm build` and `agent-bridge install` so the live daemon restarts on the new code.
- Naming: product names where people read (Claude Code, Antigravity, opencode). Kind ids where machines read (`claude`, `agy`, `opencode`): each kind id is the agent's CLI command. Antigravity's own skill and messages say `agy`, the command it runs.
- Voice for user-facing text: short sentences, no em-dashes. Errors as `<what>. <why>. <do this>.`
