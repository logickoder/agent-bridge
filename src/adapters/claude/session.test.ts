import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, ignoreAutoJoinFolder } from '../../config.js'
import { sessionEndAction, sessionStartOutput } from './session.js'

const onCfg = { autoJoin: { enabled: true, ignore: [] } }

describe('claude sessionStartOutput', () => {
  it('returns nothing when auto-join is off or folder is ignored', async () => {
    const join = vi.fn(async () => 'app-claude')
    expect(
      await sessionStartOutput('{"session_id":"s1","cwd":"/p/app"}', { CLAUDE_CODE_SESSION_ID: 's1' }, { config: () => DEFAULT_CONFIG, endpoint: () => ({ socket: '/tmp/s.sock' }), join }),
    ).toBeUndefined()
    const ignored = ignoreAutoJoinFolder(onCfg, '/p/app')
    expect(
      await sessionStartOutput('{"session_id":"s1","cwd":"/p/app"}', { CLAUDE_CODE_SESSION_ID: 's1' }, { config: () => ignored, endpoint: () => ({ socket: '/tmp/s.sock' }), join }),
    ).toBeUndefined()
    expect(join).not.toHaveBeenCalled()
  })

  it('skips bypass-permissions mode and sessions without a socket', async () => {
    const join = vi.fn(async () => 'app-claude')
    expect(
      await sessionStartOutput('{"session_id":"s1","cwd":"/p/app","permission_mode":"bypassPermissions"}', {}, { config: () => onCfg, endpoint: () => ({ socket: '/tmp/s.sock' }), join }),
    ).toBeUndefined()
    expect(
      await sessionStartOutput('{"session_id":"s1","cwd":"/p/app"}', {}, { config: () => onCfg, endpoint: () => undefined, join }),
    ).toBeUndefined()
    expect(join).not.toHaveBeenCalled()
  })

  it('joins and returns additionalContext when enabled', async () => {
    const join = vi.fn(async () => 'app-claude')
    const out = await sessionStartOutput(
      '{"session_id":"s1","cwd":"/p/app"}',
      { CLAUDE_CODE_SESSION_ID: 's1' },
      { config: () => onCfg, endpoint: () => ({ socket: '/tmp/s.sock', file: '1:2' }), join },
    )
    expect(join).toHaveBeenCalledWith('/p/app', 's1', { socket: '/tmp/s.sock', file: '1:2' })
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: expect.stringContaining('Auto-joined agent-bridge as "app-claude"'),
      },
    })
  })
})

describe('claude sessionEndAction', () => {
  it('calls leave with the env or stdin session id', async () => {
    const leave = vi.fn(async () => {})
    expect(await sessionEndAction('{"session_id":"s1"}', {}, leave)).toBe(true)
    expect(leave).toHaveBeenCalledWith('s1')
    expect(await sessionEndAction('not json', { CLAUDE_CODE_SESSION_ID: 's2' }, leave)).toBe(true)
    expect(leave).toHaveBeenCalledWith('s2')
    expect(await sessionEndAction('{}', {}, leave)).toBe(false)
  })
})
