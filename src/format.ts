/** Result of a send, for the tool reply and the CLI. */
export function formatSent(to: string, r: { id: string; live: boolean; queued: number }): string {
  return r.live
    ? `Delivered live to ${to} (id ${r.id}).`
    : `Queued for ${to} (id ${r.id}, ${r.queued} waiting). ${to} is not listening right now. It gets the message when it next listens or starts a turn.`
}
