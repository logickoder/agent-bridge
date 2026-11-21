# Open questions

## Open

- Can the user type to Antigravity while its listener runs?
- Does Antigravity re-arm its listener reliably over many turns? (Seen once.)
- Does a background `run_command` time out and kill a listener left waiting for hours?
- Two Antigravity sessions under different names at once, live.
- Does `claude --resume` keep `CLAUDE_CODE_SESSION_ID`, and so the auto name?
- Does a PreToolUse hook's deny apply inside Claude's bypass-permissions mode? The bypass guard depends on it.
- Networks: do 25s long-poll holds stay clear of Cloudflare's idle limit (about 100s) and undici's 300s `bodyTimeout` over a day of use?
- Networks: opencode's plugin service keeps the environment of whatever started it, so one machine cannot run opencode sessions in two homes at once. Document, or pass the home another way?
- Networks: how often does a quick-tunnel address change in a day of normal use? Reboots and crashes always change it.
- Networks: a recorded `/v1/open` request can be replayed within the 5-minute clock window. It opens no usable session (the replayer lacks the key), but each replay costs the host one X25519 and evicts an older session of that member (4 per member).
- Networks: the tunnel provider sees member X25519 keys in `/v1/open` requests, so it can spend a member's reconnect allowance. It can also just drop that member's traffic, so this adds nothing new.
- Networks: what the host sees by design: handles, who sends to whom and when, padded sizes, envelope ids. Worth padding presence and adding cover traffic?
- Networks: after a reboot, nothing holds the port until the daemon first starts, so a tunnel that starts at boot forwards to a free port in between. `--socket` avoids it where the tunnel supports sockets. Worth a launchd or systemd entry for the keeper?
- Networks: Tailscale Funnel and ngrok socket support: unknown.
- Networks: the invite token sits in the agent's transcript. It is single use and expires in 24 hours; is that enough, or should invites be redeemable only once a host-side confirmation passes?

- Networks: if the host's mailbox file for a member is corrupt at start, it is set aside and the new one numbers from 1 again, while the member's cursor stays high: mail below the old cursor is skipped. Rare (a corrupt file); recovery would need the host to learn each member's cursor.

## Answered

- **Does a Cloudflare named tunnel's `service: unix:` ingress work with `--socket`?** Yes: `/v1/health` answered through a named tunnel pointed at `net/http.sock` (live, 2026-11-21).
- **Does Claude Code pass `AGENT_BRIDGE_HOME` to Bash and its push endpoint?** Yes: two sessions in separate homes each joined their own daemon (live, 2026-11-19). Monitors and hooks were not exercised.

- **Does `/bridge` reach the Antigravity skill as a slash command?** Yes (live, 2026-11-02).
- **Is the working directory the project folder in each agent?** Yes: each got `<folder>-<kind>` (live, 2026-11-02).
- **Does the PreInvocation fallback fire live?** Yes: it delivered a queued message after Antigravity resumed (live, 2026-11-02).
- **Does Antigravity's hook get the agentapi address and token?** No. Only `ANTIGRAVITY_CONVERSATION_ID` (probe hook, 2026-11-02).
- **Does agentapi survive Antigravity restarting and resuming the conversation?** No. The endpoint fails; the hook and `join` recover (live, 2026-11-02).
- **Antigravity to Claude through a live Claude session?** Yes, through the monitor and the socket (live, 2026-11-02).
