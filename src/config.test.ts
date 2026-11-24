import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, formatAutoJoin, ignoreAutoJoinFolder, shouldAutoJoin, unignoreAutoJoinFolder } from './config.js'

describe('auto-join config', () => {
  it('defaults to off', () => {
    expect(shouldAutoJoin(DEFAULT_CONFIG, '/p/app')).toBe(false)
    expect(formatAutoJoin(DEFAULT_CONFIG)).toBe('auto-join: off.')
  })

  it('joins every folder when enabled and ignore list is empty, failing closed without a folder', () => {
    const cfg = { autoJoin: { enabled: true, ignore: [] } }
    expect(shouldAutoJoin(cfg, '/p/app')).toBe(true)
    expect(shouldAutoJoin(cfg, undefined)).toBe(false)
    expect(formatAutoJoin(cfg)).toBe('auto-join: on.')
  })

  it('skips exact ignored folders, normalizing trailing slashes', () => {
    const cfg = ignoreAutoJoinFolder({ autoJoin: { enabled: true, ignore: [] } }, '/p/scratch/')
    expect(shouldAutoJoin(cfg, '/p/scratch')).toBe(false)
    expect(shouldAutoJoin(cfg, '/p/scratch/')).toBe(false)
    expect(shouldAutoJoin(cfg, '/p/scratch/sub')).toBe(true)
    expect(shouldAutoJoin(cfg, '/p/app')).toBe(true)
  })

  it('deduplicates ignored folders and unignores them cleanly', () => {
    let cfg = ignoreAutoJoinFolder({ autoJoin: { enabled: true, ignore: [] } }, '/p/a')
    cfg = ignoreAutoJoinFolder(cfg, '/p/a/')
    cfg = ignoreAutoJoinFolder(cfg, '/p/b')
    expect(cfg.autoJoin.ignore).toEqual(['/p/a', '/p/b'])
    expect(formatAutoJoin(cfg)).toBe('auto-join: on.\nIgnored folders:\n  /p/a\n  /p/b')

    cfg = unignoreAutoJoinFolder(cfg, '/p/a')
    expect(cfg.autoJoin.ignore).toEqual(['/p/b'])

    cfg = unignoreAutoJoinFolder(cfg, '/p/b')
    expect(cfg.autoJoin.ignore).toEqual([])
    expect(formatAutoJoin(cfg)).toBe('auto-join: on.')
  })
})
