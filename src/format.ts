/** Result of a send, for the tool reply and the CLI. */
export function formatSent(to: string, r: { id: string; live: boolean; queued: number; listening: string[] }): string {
  if (r.live) return `Delivered live to ${to} (id ${r.id}).`
  const queued = `Queued for ${to} (id ${r.id}, ${r.queued} waiting). ${to} gets it after the messages ahead of it, or when it next listens or starts a turn.`
  return r.listening.length ? `${queued} Listening now: ${r.listening.join(', ')}. If ${to} has ended, resend to one of them.` : queued
}
