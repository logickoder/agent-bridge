import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readJson, writeJson } from '../src/lib/json-file.js'

// Real files in a temp dir, so this lives in test/, not next to the unit.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-json-'))
const Shape = z.object({ n: z.number() })
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('readJson', () => {
  it('reports a missing file', () => {
    expect(readJson(path.join(dir, 'none.json'), Shape)).toEqual({ status: 'missing' })
  })

  it('reports bad JSON and a wrong shape as invalid', () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), '{nope')
    fs.writeFileSync(path.join(dir, 'shape.json'), '{"n":"x"}')
    expect(readJson(path.join(dir, 'bad.json'), Shape)).toEqual({ status: 'invalid', reason: 'is not valid JSON' })
    expect(readJson(path.join(dir, 'shape.json'), Shape)).toMatchObject({ status: 'invalid', reason: expect.stringMatching(/expected shape/) })
  })
})

describe('writeJson', () => {
  it('creates the directory, round-trips, and leaves no temp file', () => {
    const file = path.join(dir, 'nested', 'out.json')
    writeJson(file, { n: 1 }, { pretty: true })
    expect(readJson(file, Shape)).toEqual({ status: 'ok', value: { n: 1 } })
    expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "n": 1\n}\n')
    expect(fs.readdirSync(path.dirname(file))).toEqual(['out.json'])
  })
})
