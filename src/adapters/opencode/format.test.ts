import { describe, expect, it } from 'vitest'
import { deliveredText } from './format.js'

describe('deliveredText', () => {
  const base = { id: 'm1', to: 'oc', text: 'hi', ts: 't' }

  it('adds the caution only for another user\'s agent', () => {
    expect(deliveredText({ ...base, from: 'claude', verified: true })).not.toMatch(/untrusted/)
    const remote = deliveredText({ ...base, from: 'planner@bob', verified: false, origin: { network: 'team', member: 'bob', keyVerified: false, allow: 'ask' } })
    expect(remote).toContain('to "planner@bob"')
    expect(remote).toMatch(/untrusted input/)
  })
})
