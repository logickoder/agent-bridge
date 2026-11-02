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
- **Push endpoints** (Claude's inbox socket, agy's agentapi) are acked when the push succeeds. A failed push keeps the message queued, drops the endpoint, and the fallbacks take over. `send` then says "Handed to X's direct delivery", not "Delivered live".
- **Listeners** reconnect after a daemon restart, a dropped socket or a slow start, with backoff up to 5s.
- `send` lists who is online when the recipient is not.
- One daemon at a time, enforced by a lock file. Clients start it on demand.

## Sender check

A send from inside an agent session carries its session id, and the daemon accepts the sender name only if that session holds it. Other sends (a plain shell, agy's MCP tool) arrive marked `(unverified)`, and agents are told not to reply to them blindly.

It stops mislabeled and casual spoofing, such as an agent told to "send as lead". It is not a security boundary: every session runs as your OS user, so any of your processes that finds another session's id can send as it. `status` shows a tag instead of raw session ids so they are not one copy away.

Message text is fenced between `--- message text` and `--- end of message text ---`, and lines inside that look like bridge metadata are escaped.
