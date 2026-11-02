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
| `src/lib/` | Generic helpers, no bridge logic: `errors` (errno codes, `toError`, `isDaemonDown`), `json-file` (validated read, atomic write), `log` (tagged stderr), `wire` (JSON lines), `args`, `config` (other tools' config and PATH links) |
| `src/adapters/types.ts` | The `Adapter` interface every agent kind implements |
| `src/adapters/index.ts` | `ADAPTERS` registry, typed `Record<PeerKind, Adapter>` |
| `src/adapters/<kind>/` | Everything agent-specific. `index.ts` exports the adapter and is the folder's only entry point. The rest is split by concern: `mcp.ts`, `install.ts`, `names.ts` (constants), and the wake path (`agy/push.ts`, `agy/listen.ts`, `agy/hook.ts`, `agy/format.ts`, `claude/socket.ts`, `claude/monitor.ts`, `claude/format.ts`, `claude/channel/`) |
| `src/adapters/agy/skill/` | The agy `/bridge` skill, copied by install |
| `src/adapters/opencode/plugin/` | The opencode plugin. Standalone (node built-ins only): install copies the built file into opencode's plugins folder |
| `src/adapters/claude/plugin/` | The Claude plugin: `/bridge` (socket) and `/bridge-monitor` skills sharing `shared/peer-messages.md`, the monitor, and the bypass-guard hook. Registered by install through the repo's `.claude-plugin/marketplace.json` |
| `docs/` | User docs (`concepts.md`, `install.md`, `agents/`) and the design record (`decisions.md`, `live-tests.md`, `adding-an-agent.md`, `open-questions.md`). Agent findings live in `docs/agents/<agent>.md`; never name a file there `claude.md`, macOS loads it as `CLAUDE.md` |
| `test/` | Tests that touch real files, sockets or processes. `e2e.test.ts` runs against `dist/cli.js` |

## Rules

- Gate: `pnpm check` (typecheck, unit, e2e) before calling work done.
- Unit tests sit next to the unit (`*.test.ts`) and do no I/O. Anything that spawns processes or opens sockets goes in `test/`.
- e2e waits on conditions (`until`, `online`), never on fixed sleeps. Fixed sleeps flaked under load.
- An adapter's `index.ts` loads its other modules with `await import()` inside each member. `agy-hook` runs on every agy model call and must not load install, MCP or the other adapters.
- Shared code (`mcp/tools.ts`, `format.ts`, `daemon/`) never names an agent kind, command or default name. Pass such text in from the adapter (`bridgeTools({ asHelp })`).
- Import an adapter only through its `index.ts`. Files inside an adapter folder do not import from other adapters.
- Use `src/lib/` for errno checks, JSON files, logging and JSON lines. Do not hand-roll them in a module. Logs go to stderr only: stdout carries MCP and hook output.
- Validate everything that crosses a process boundary with the schemas in `src/schema.ts`.
- New agent kind: add it to `PEER_KINDS`, create `src/adapters/<kind>/` with an `index.ts` exporting the `Adapter`, register it in `ADAPTERS`, add e2e coverage. See `docs/adding-an-agent.md`. Never branch on kind outside `src/adapters/`.
- Never ship an agy PreToolUse hook that returns `{}` for calls it does not mean to gate. agy treats `{}` as deny (`docs/agents/agy.md`, finding 5).
- After changing `src/`, run `pnpm build` and `agent-bridge install` so the live daemon restarts on the new code.
- Voice for user-facing text: short sentences, no em-dashes. Errors as `<what>. <why>. <do this>.`
