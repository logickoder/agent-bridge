import readline from 'node:readline/promises'

/**
 * Asks a question on the terminal and returns the typed line. Undefined when stdin is not a terminal (a pipe, a
 * script, an agent's shell), so the caller can refuse instead of reading an answer nobody typed.
 */
export async function askTerminal(question: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}
