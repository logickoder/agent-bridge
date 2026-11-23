import { describe, expect, it } from 'vitest'
import { guardDecision } from './guard.js'

const input = (permission_mode: string, command: string) => JSON.stringify({ permission_mode, tool_name: 'Bash', tool_input: { command } })

describe('guardDecision', () => {
  it('denies a socket join in bypass mode and points to the monitor', () => {
    const out = guardDecision(input('bypassPermissions', 'agent-bridge join --kind claude'))
    expect(out).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } })
    expect(JSON.stringify(out)).toMatch(/agent-bridge:bridge-monitor/)
  })

  it('allows a monitor-mode join in bypass mode, and any join otherwise', () => {
    expect(guardDecision(input('bypassPermissions', 'agent-bridge join --kind claude --no-push'))).toBeUndefined()
    expect(guardDecision(input('default', 'agent-bridge join --kind claude'))).toBeUndefined()
    expect(guardDecision(input('auto', 'agent-bridge join --kind claude reviewer'))).toBeUndefined()
  })

  it('ignores join and --no-push written in the text of a send', () => {
    const send = "agent-bridge send --as me peer - <<'AB_END_1234abcd'\nRun agent-bridge join --kind claude first.\nAB_END_1234abcd"
    expect(guardDecision(input('bypassPermissions', send))).toBeUndefined()
    const hiddenNoPush = "agent-bridge join --kind claude && cat <<'M'\n--no-push\nM"
    expect(guardDecision(input('bypassPermissions', hiddenNoPush))).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })

  it('checks every line outside heredoc bodies', () => {
    const deny = { hookSpecificOutput: { permissionDecision: 'deny' } }
    expect(guardDecision(input('bypassPermissions', 'ls\nagent-bridge join --kind claude'))).toMatchObject(deny)
    expect(guardDecision(input('bypassPermissions', "cat <<'M'\nhi\nM\nagent-bridge join --kind claude"))).toMatchObject(deny)
    expect(guardDecision(input('bypassPermissions', "cat <<'M'\nagent-bridge join --kind claude"))).toMatchObject(deny)
  })

  it('ignores other commands and bad input', () => {
    expect(guardDecision(input('bypassPermissions', 'ls -la'))).toBeUndefined()
    expect(guardDecision('not json')).toBeUndefined()
  })
})
