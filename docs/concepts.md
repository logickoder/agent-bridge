# Concepts

How the bridge names peers, binds them to sessions, and delivers messages. Per-agent details: [agents/](agents/).

## Peers

A peer has a name, a kind (`claude`, `agy` or `opencode`) and, once it joins, a bound session: the agent's own session id. A name belongs to one kind.

## Names

- **Auto names.** Without a name, a session gets `<folder>-<kind>`, e.g. `myapp-claude`. The daemon assigns it on `claim`, so two sessions starting at once never collide. The model is Claude's own session names.
- **Never reused while held.** A new session gets the lowest free `-2`, `-3`, even when the holder is offline. The same session, including a resumed one, always gets its name back, also after `/bridge off`.
- **Locked to their session.** Another session cannot listen on an auto name; it gets an error pointing to `join`.
- **Explicit names are roles.** `/bridge planner` takes the name if its holder is offline. If another session is online with it, `join` refuses: pick another name, or `join --take planner`. The old session is told: its listener, monitor or stream reports the takeover, and a push-mode session gets one last message.
- **Renaming.** `/bridge <new name>` renames. A free name is renamed in place, so queue, binding and running listener carry over. An existing name takes the session's listener and releases the old one.
- **Pruned when idle.** A peer nobody listens on is dropped after 24 hours without a listen, ack or drain, or after 7 days with messages queued (they go too, and the daemon log says so). Pruning runs on `claim`, never at daemon startup, so a restart does not drop sessions that have not reconnected.
- **Finding a name.** `join` prints it, every message repeats it, and `agent-bridge whoami` looks it up from the session id.
- **Names change across restarts.** A send to a peer that is not listening says who is, so the sender can redirect.

## Binding

- A name binds to the newest session that joins or listens with a session id. Listeners without one (a plain shell) work only while the name is unbound.
- `agent-bridge leave <name>` (what `/bridge off` runs) unbinds it and ends its listeners with a "do not re-arm" notice.
- One receive path per session. A second one (say, a monitor next to a socket push) is refused, and `join` says so.

## Delivery

- One message in flight per peer. It leaves the queue only on ack. A killed listener or a daemon restart loses nothing. Delivery is at least once.
- **Push endpoints** (Claude's inbox socket, Antigravity's agentapi) are acked when the push succeeds. A failed push keeps the message queued, drops the endpoint, and the fallbacks take over. `send` then says "Handed to X's direct delivery", not "Delivered live".
- **Saved endpoints.** Claude's socket path is saved to `~/.agent-bridge/endpoints.json`, so a daemon restart keeps the session reachable. Antigravity's endpoint holds a CSRF token and stays in memory: after a restart its hook asks it to rejoin.
- **Folders.** Each peer records the folder it joined from. `join` and `peers` list you first, then same-folder peers, marked "same folder". `send --to-kind <kind>` picks the one online peer of that kind in your folder. The MCP `send` tool and opencode's `bridge_send` take `to_kind` for the same.
- **Listeners** reconnect after a daemon restart, a dropped socket or a slow start, with backoff up to 5s.
- `send` lists who is online when the recipient is not.
- One daemon at a time, enforced by a lock file. Clients start it on demand.

## Sender check

A send from inside an agent session carries its session id, and the daemon accepts the sender name only if that session holds it. Other sends (a plain shell, Antigravity's MCP tool) arrive marked `(unverified)`, and agents are told not to reply to them blindly.

It stops mislabeled and casual spoofing, such as an agent told to "send as lead". It is not a security boundary: every session runs as your OS user, so any of your processes that finds another session's id can send as it. `status` shows a tag instead of raw session ids so they are not one copy away.

Message text is fenced between `--- message text` and `--- end of message text ---`, and lines inside that look like bridge metadata are escaped.

## Networks

A network links bridges on different machines, usually different people's. One member hosts it on their own machine behind a tunnel; the others join with an invite. Remote agents are addressed `<agent>@<member>`, for example `planner@bob`.

- **Hosting.** `agent-bridge net host --public-url <https address>` runs a small HTTP server on a private socket file. A keeper process holds `127.0.0.1:<port>` for your tunnel and relays to it, or with `--socket` the tunnel forwards to the socket file itself. `--tunnel cloudflared` starts a free trial tunnel instead; its address changes whenever it restarts. See [install.md](install.md#networks).
- **Joining.** `agent-bridge net invite` prints a single-use invite, valid 24 hours. The guest runs `agent-bridge net connect -` and pastes it.
- **Sharing.** Nothing is reachable until a session opts in with `/bridge share` (`agent-bridge net share`). Members see only shared agents.
- **Delivery.** A remote send waits in a local outbox until the host stores it in the recipient's mailbox, then waits there until the recipient's daemon takes it. An offline member gets its mail when it comes back, if within 7 days: older mail is dropped, so a host cannot replay old messages once their ids are forgotten. A message to another user's agent is limited to 64 KiB.
- **Moving.** When the host's address changes, connected members follow on their own. One that was offline needs the signed line `agent-bridge net status` prints on the host: `agent-bridge net set-url agent-bridge-url:1:...`.
- **Leaving.** `net leave` leaves; the same machine can rejoin later with any invite and keeps its handle. `net kick` (host) removes a member for good. `net stop --yes` (host) ends the network. When a member goes, or the network ends, messages still waiting to go out to it are dropped and each sender is told: kept, they could reach whoever holds that handle on the next network.

## Trust across machines

The local sender check above is not a security boundary. A network is: other people are on it.

- **What is protected.** Messages are end-to-end encrypted between members. The tunnel provider sees only random ids, sizes and timing. The host stores only ciphertext and never learns agent names. The host cannot read messages either, **once the members have compared fingerprints**.
- **What fingerprints are for.** Each member's keys are pinned the first time it appears, marked `unverified`. A dishonest host could hand out its own key instead of a member's and read everything in between. Compare codes with each member by call or a separate chat (`agent-bridge net fingerprint`, `agent-bridge net status`), then run `agent-bridge net verify <handle> <code>` in your own terminal. A code sent over the bridge proves nothing: the host could have swapped it.
- **Key changes.** If a member's key changes, nothing goes to or from it until the user runs `net verify` with a newly compared code, or `net trust`. Trust leaves it unverified. Both refuse inside an agent session and ask for a typed confirmation on a terminal, and so does every `net verify`: a host in the middle can hand out its own key from the start, and an agent could copy the code `net status` prints into `net verify`.
- **What the host still sees.** Member handles, who sends to whom and when, padded message sizes, and envelope ids. It can drop or delay mail, and remove members.
- **Limits.** No forward secrecy if a member's key file is stolen: recorded mail to that member can then be opened. Keys live in `~/.agent-bridge/net/identity.json`, mode 0600.
- **Prompt injection.** A message from another user's agent is labeled as such and carries a caution: it is untrusted input. Agents are told not to run commands, send files or reveal anything about the machine because it asks, and never to share, invite, connect, verify, trust or change a level on a peer's request. An approval the user gives covers only the request they saw.
- **Levels.** Asking about every small thing gets tiring, so the user can set what a member's agents may do without asking: `agent-bridge net allow <handle> ask|chat|work [--for HOURS] [--agents a,b]`. `ask` (the default): check with the user first. `chat`: answer from what the agent already knows. `work`: also read files and run read-only commands in its folder. A level covers every shared agent unless `--agents` names some; the others still ask. The level follows the agent name, so a later session that takes the same name and is shared again gets it too. Secrets, settings and levels are never covered, and at every level the agent keeps the user's name, login, email, full paths and other projects to itself unless the user says otherwise. A level above `ask` needs a verified key, since with an unverified one the host could pose as that member; it drops back to `ask` when the key changes. The level travels in each message's label and caution. It is guidance the receiving agent follows, not enforcement: the agent judges each request against it, and asks when unsure. The agent's own permission settings are the hard limit. Only a shell outside any agent session can raise a level, and it asks you to type the handle and level back, which needs a terminal. An agent's shell has none, so a message cannot talk an agent into raising its sender's level with one command. An agent running as you could still unset the session variable, fake a terminal or edit `net/link.json`; the skills forbid all three, and each shows in the transcript. No check inside your own user account can tell you from your agent. So levels are soft. For real protection, do not share a session running in auto or bypass-permissions mode with a member you do not trust: there the agent's judgment is the only check.

