# Decisions

Why the bridge works the way it does. Findings referenced here live in [agents/](agents/) and [concepts.md](concepts.md).

## Core

| Decision | Why |
|---|---|
| One daemon, Unix socket, disk queues | Survives restarts. Every agent-side piece is a thin client |
| Single-instance lock file | Concurrent spawns once left three daemons running with stale state. The pid goes into a temp file hard-linked into place, so the lock never exists empty. A stale lock is renamed aside and checked before takeover. An empty lock is refused until it is 5s old |
| Ack before dequeue, one message in flight per peer | No loss when a listener dies. Keeps order |
| A superseded waiter finishes its in-flight message first | Evicting it would deliver the message twice. It is told "superseded" on ack, so it cannot take the name back after a restart |
| Listeners retry every connect failure, with backoff | A failed connect or ECONNRESET used to end the listener: Antigravity woke for nothing, Claude stopped receiving |
| Hub is pure, store injected | Delivery and binding rules are unit-tested without sockets or disk |
| Hand-written MCP stdio, no MCP SDK | Small surface: initialize, ping, tools/list, tools/call |
| Strict TypeScript, zod at boundaries, tsc to `dist/` | Follows the owner's TypeScript rules |

## Adapters

| Decision | Why |
|---|---|
| One `Adapter` interface, one registry | Only wake, identity and knowledge differ between agents. `ADAPTERS: Record<PeerKind, Adapter>` fails to compile when a kind has no adapter. Nothing outside `src/adapters/` branches on kind |
| Adapters load their modules per command | Antigravity's hook runs on every model call and must not load install, MCP or other adapters |
| `join` is core, with `--kind` | A shell can carry two agents' session ids (Antigravity started from a Claude terminal inherits Claude's) |
| `mcp <kind>`, not env sniffing | Each client's config names its kind; sniffing does not scale past two |
| Push endpoints are listeners in the hub (`PushConn`) | Delivery, ack and fallback reuse the same rules for every push path |
| One receive path per session | A push next to a stream listener is refused, and `join` reports it |
| An adapter with `alive` gets its endpoints saved | Claude's socket path is safe on disk and survives a daemon restart. Antigravity's holds a CSRF token, so it has no `alive` and stays in memory. A restored endpoint is checked before it gets mail. The check compares the socket file's inode and creation time: the path holds a pid, which a later session can reuse |
| Peers record their folder; the daemon resolves `--to-kind` | The agent next to you is usually the one you mean. The hub holds the folders, so any client can use it. Several matches refuse rather than guess. Exact folder only: a subfolder does not match |

## Per agent

| Decision | Why |
|---|---|
| Claude: socket default, monitor and channel by choice | The inbox socket wakes an idle session with nothing extra running (Claude finding 8), and matches Antigravity's shape: `join` registers, the daemon pushes and acks. The line format is undocumented, so the monitor and channel stay as choices. No auth line, so Claude's inbound controls apply |
| Claude: a plugin hook keeps bypass sessions off the socket | Held socket messages are lost if denied or expired. Only hook input exposes the permission mode. The hook denies a socket join in `bypassPermissions` and its reason tells Claude to use the monitor. A shell prefilter keeps it off other Bash calls. Unverified: whether a hook deny applies inside bypass mode |
| Claude: keyed on `CLAUDE_CODE_SESSION_ID` | Set for Bash, monitors and MCP servers, so a resumed session keeps its name |
| Claude: listen by session, wait for `claim` | The monitor starts when the skill is invoked, possibly before `join`, so it cannot know the name. The daemon parks it until the session holds one |
| Antigravity: agentapi push by default | No background listener or re-arm loop (Antigravity finding 8). The token stays in daemon memory and reaches agentapi through its environment, never its arguments |
| Antigravity: the hook asks Antigravity to rejoin after a lost endpoint | Hooks lack the token (Antigravity finding 9), so only `join` can register. The hint fires once per lost endpoint. Chosen over saving the token to disk |
| Antigravity: push runs only an absolute `.../agy` | The endpoint arrives over the socket. The socket is 0600, so this is defence in depth |
| Antigravity: hook drain is acked after print | The hook's 1.5s cap or Antigravity's 3s kill could fire between drain and print |
| Antigravity: the PreInvocation hook never blocks | 1.5s cap, `{}` on any failure |
| Antigravity: `/bridge` skill, not SessionStart auto-join | `hooks.json` is global: auto-join would make every Antigravity session take the binding |
| opencode: an in-process plugin | Its tools know the sessionID and `ctx.session.prompt` wakes an idle session, so no ports or passwords. The plugin stays thin; naming, queues and acks stay in the CLI |

## Names and senders

| Decision | Why |
|---|---|
| Auto names `<folder>-<kind>[-n]`, never reused while held | Claude's own session-name model. No "is it still active" guesswork. The daemon assigns names, so concurrent starts cannot collide |
| Auto names are locked to their session | A stale session re-arming would otherwise steal a name re-claimed after pruning |
| An online explicit name needs `--take` | Taking a name from a working session is a hijack, and in push mode the old session would stop receiving silently. Offline holders are still taken over (restart and reclaim). A push-mode holder gets a takeover notice |
| `join <name>` renames | A later name moves the session's peer: in place if free, carrying queue and listeners. A running monitor follows without reconnecting |
| Prune idle peers: 24h, or 7 days with mail queued | Auto names would pile up, and a dead peer that keeps receiving would never free its name. Never at startup. `lastSeen` writes are throttled against the stored value |
| Online peers only by default | An offline peer cannot answer. `join` and `peers` list online peers and count the rest; `peers --all` and `status` keep everything |
| Check senders by session, fence message text | Anyone local could send under any name, and text could fake a bridge header. Unchecked sends are labeled; bodies are fenced and header-like lines escaped |
| No per-session send keys | A key file found from the session id is found just as easily by a spoofer who sets that id. Instead `status` shows tags and the docs say the check is not a security boundary |

## Networks

How bridges on different machines and users link. Code in `src/net/`. Trust model in [concepts.md](concepts.md#networks).

| Decision | Why |
|---|---|
| One member hosts; a star through its daemon | Nothing passes through a server agent-bridge runs. Guests only connect outward, so only the host needs a tunnel |
| Bring your own tunnel (`--public-url`); `--tunnel cloudflared` as a trial only | Any tunnel with a fixed address works. Cloudflare calls quick tunnels testing-only, with no uptime guarantee and 200 open requests at most, and their address changes on every restart. The keeper runs cloudflared, so a daemon restart adopts it and keeps the address. It stops the tunnel after the daemon has been gone a minute, freeing the port only after cloudflared exits. Quick tunnels cannot forward to a socket file (tested), so trial mode uses a port. "Trial" shows in host, status and invite output |
| The daemon listens on a private socket file; a keeper process holds the port | A tunnel must never forward to a port another program could take, and the daemon comes and goes. The keeper outlives it, relays to `net/http.sock` (0600), answers 503 while the daemon is down, and holds the port until `net stop`. `--socket` skips the port for tunnels and proxies that can forward to a Unix socket, which also covers reboots |
| HTTP long-poll, 25s holds, no SSE or WebSocket | Quick tunnels do not carry SSE. One code path works through every tunnel. Each guest holds one request |
| Two crypto layers on node:crypto, no new dependency | Outer channel: X25519 static-static plus random ids from both sides through HKDF, chacha20-poly1305 with a direction and counter nonce, a 1024-wide replay window, AAD binding session, path and counter. The tunnel sees ids, sizes and timing only. Inner envelope: ephemeral plus static X25519 per message, padded to fixed sizes. The host routes by member handle and stores ciphertext |
| Agent names and peer lists travel inside envelopes | The host never learns which agents exist. Presence is an envelope like any message |
| Keys pinned on first sight, `unverified` until `net verify` | The host signs the member list, which proves only that the host sent it. A dishonest host can hand out its own key in place of a member's, so the promise is worded as "the host cannot read your messages once you have compared fingerprints". Codes are compared out of band; the skills tell agents never to trust a code that arrived over the bridge |
| A changed key blocks both directions | Mail from the member is held, sends are refused, until `net trust` or `net verify`. Trust leaves the key unverified |
| Invites are data, parsed by the CLI, read from stdin | An agent never opens the address inside one. The token is single use, 24h, stored as a hash. The URL policy is https, or http on loopback only |
| Remote messages carry `origin` and a caution | Another person's agent is untrusted input. Remote senders cannot use `to_kind`. A guessed unshared name and an unknown one get the same refusal |
| Opt-in per session (`/bridge share`) | Joining a network exposes nothing. Binding a name to a new session clears its share |
| Bounces are fixed codes, worded by the sender's side | A member can never put its own words into a bridge notice. A bounce counts only for a message really sent to that member |
| An agent at 50 unread network messages bounces new ones as busy | Holding them would stop the whole mailbox for that machine's other agents |
| Signed address updates (`agent-bridge-url:1:...`) | A cut-off guest needs the host's new address out of band. It must be signed by the host key pinned at join, with a rising sequence number, so a stranger's address or a replayed old one cannot redirect it |
| Reconnects get an allowance per member key | Behind a tunnel every caller looks like 127.0.0.1. Strangers never see member keys, so junk requests cannot keep members out. Joins and strangers have separate pools |
| Leave keeps the handle for that key; kick bans the key | A member who left can rejoin with any invite under its old handle, so other members' pins still fit. A kicked key needs an invite reserved for it, and is told why |
| Per-member levels (`ask`, `chat`, `work`) set by the user | Asking about every small request is tiring, and a blanket approval drifts to bigger requests. A level states what needs no check; everything beyond it still asks. Guidance in the caution, not enforcement: free text cannot be classified by code |
| Only a verified key holds a level above `ask`; a key change resets it | With an unverified key the host could pose as the member and inherit the level. A new key is a new party |
| `net allow` raises a level only outside an agent session | A message could talk an agent into raising its sender's level. Lowering works anywhere |
| `net verify` and `net trust` need the user's terminal | A host in the middle can hand out its own key from the first pin, and `net status` prints that key's code, so an agent talked into it could mark a swap verified. The user runs verify themselves |
| A member refuses a message whose send time is over 7 days old, or an hour ahead | Envelope ids are remembered for 8 days; past that, a host could deliver an old message again. The cost: mail that waited over a week at the host for an offline member is dropped. The sender gets a bounce saying why |
| Mail held for an undecided key is capped at 200 per member, oldest dropped | Whoever holds the new key could otherwise grow `link.json` without bound while the user decides |
| Ending a network drops the whole outbox and tells each sender | A kept outbox would go to whoever holds the same handle on the next network |
| Raising a level asks you to type it back on a terminal | The session check is one `env -u` away. A typed confirmation needs a terminal, which an agent's shell lacks, so a raise takes a deliberate, visible workaround. Not a boundary: the agent runs as you |
| `--agents` scopes a level to named shared agents, by name | One share for a joint project and another for private work should not get the same level. Keyed by name, like sharing; a name drop falls back to `ask` |
| A privacy rule at every level: no user name, login, email, full paths or other projects unless the user says so | Live test: at `work`, Haiku volunteered the login name and the absolute path. Levels limit what a member can ask for, not what the agent volunteers |
| One network per daemon in v1 | Keeps addresses (`agent@member`), status and the CLI simple |

## Superseded

- **`claude-bridge` launcher as the only Claude path.** Replaced by the plugin monitor, then by the inbox socket. The channel launcher is now `agent-bridge claude`, opt-in.
- **Claude plugin monitor as the default.** Replaced by the inbox socket; the monitor stays as `/bridge-monitor`.
- **Antigravity listener as the default, re-armed after every message.** Replaced by agentapi push; the listener is a fallback.
- **Newest tagged session takes any name.** Replaced by auto names locked to their session and `--take` for online explicit names.
- **Antigravity passes `as` on every MCP send.** Antigravity now replies with `agent-bridge send` through `run_command`, which carries its session id, so its sends are checked.

## Rejected

- MCP notifications to Antigravity (Antigravity finding 1).
- Stop hook `continue` (Antigravity finding 3).
- A PreToolUse rewrite of `agent-bridge listen` to tag the conversation (Antigravity finding 5). Replaced by the env var (Antigravity finding 6).
- User-scope Claude MCP registration for channels (Claude finding 3).
- Checking the parent process for the channel flag. Works without a wrapper but needs a process-tree walk.
- A skill or plugin that enables channels without a launch flag. Channels turn on only at launch, no setting enables them, and plugins outside `claude-plugins-official` still need the development flag.
- Fixed sleeps in e2e tests. They flaked under load; tests wait on conditions.
