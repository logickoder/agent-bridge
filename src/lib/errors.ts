/** The errno code of a Node error (`ENOENT`, `EEXIST`, ...), if it has one. */
export function errnoCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined
}

/** Anything thrown, as an Error. */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/** Nobody is listening on the daemon socket: it is missing or refuses connections. */
export function isDaemonDown(err: unknown): boolean {
  const code = errnoCode(err)
  return code === 'ENOENT' || code === 'ECONNREFUSED'
}
