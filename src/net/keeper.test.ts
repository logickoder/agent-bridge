import { describe, expect, it } from 'vitest'
import { parseQuickTunnelUrl } from './keeper.js'

describe('parseQuickTunnelUrl', () => {
  it('finds the address in cloudflared\'s banner', () => {
    const log = [
      '2026-11-19T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
      '2026-11-19T10:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
      '2026-11-19T10:00:01Z INF |  https://grey-owl-tree-42.trycloudflare.com                                                 |',
    ].join('\n')
    expect(parseQuickTunnelUrl(log)).toBe('https://grey-owl-tree-42.trycloudflare.com')
  })

  it('ignores cloudflared\'s own api host and look-alike hosts', () => {
    expect(parseQuickTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeUndefined()
    expect(parseQuickTunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF')).toBeUndefined()
    expect(parseQuickTunnelUrl('https://owl.trycloudflare.com.evil.example')).toBeUndefined()
  })
})
