export type Log = (msg: string) => void

/** Tagged stderr logger. stdout belongs to MCP and hook output, so logs never go there. */
export function logger(tag?: string, opts: { timestamps?: boolean } = {}): Log {
  const prefix = tag ? `[agent-bridge ${tag}]` : '[agent-bridge]'
  return msg => {
    const time = opts.timestamps ? ` ${new Date().toISOString()}` : ''
    process.stderr.write(`${prefix}${time} ${msg}\n`)
  }
}
