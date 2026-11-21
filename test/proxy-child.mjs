// The tunnel stand-in, in its own process: test commands run synchronously and would block an in-process proxy.
// Forwards 127.0.0.1:<own port> to the target port and appends every byte, both ways, to the record file.
// Control on stdin, one command per line: `target <port|socket path>`, or `tamper up|down` to flip one base64 character in
// the next sealed RPC frame going to the host (up) or coming back (down). Prints `port <n>` once listening, and
// `tampered <dir>` when it flipped one.
import fs from 'node:fs'
import net from 'node:net'
import readline from 'node:readline'

const [record] = process.argv.slice(2)
/** A port, or a socket file path. */
let target = 0
const armed = { up: false, down: false }
// An RPC request body carries `"frame":{"n":`; an RPC reply body is a bare frame, `{"n":...,"c":"...`.
const FRAME = { up: '"frame":{"n":', down: '{"n":' }

/** Flips one character inside the frame's ciphertext, keeping the length so HTTP framing stays valid. */
function maybeTamper(dir, d) {
  if (!armed[dir]) return d
  const text = d.toString('latin1')
  if (!text.includes(FRAME[dir])) return d
  const at = text.indexOf('"c":"', text.indexOf(FRAME[dir]))
  if (at < 0) return d
  const i = at + 5 + 8
  const out = Buffer.from(d)
  out[i] = out[i] === 0x41 ? 0x42 : 0x41
  armed[dir] = false
  process.stdout.write(`tampered ${dir}\n`)
  return out
}
const server = net.createServer(client => {
  const upstream = typeof target === 'string' ? net.connect(target) : net.connect(target, '127.0.0.1')
  const save = d => fs.appendFileSync(record, d)
  client.on('data', d => {
    save(d)
    upstream.write(maybeTamper('up', d))
  })
  upstream.on('data', d => {
    save(d)
    client.write(maybeTamper('down', d))
  })
  const end = () => {
    client.destroy()
    upstream.destroy()
  }
  for (const s of [client, upstream]) {
    s.on('error', end)
    s.on('close', end)
  }
})
server.listen(0, '127.0.0.1', () => process.stdout.write(`port ${server.address().port}\n`))
readline.createInterface({ input: process.stdin }).on('line', line => {
  const [cmd, arg] = line.trim().split(' ')
  if (cmd === 'target') target = /^\d+$/.test(arg) ? Number(arg) : arg
  if (cmd === 'tamper' && (arg === 'up' || arg === 'down')) armed[arg] = true
  process.stdout.write(`ok ${cmd}\n`)
})
process.stdin.on('end', () => process.exit(0))
