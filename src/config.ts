import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJson } from './lib/json-file.js'
import { CONFIG_FILE, ensureHome } from './paths.js'
import { BridgeConfig } from './schema.js'

export const DEFAULT_CONFIG: BridgeConfig = { autoJoin: { enabled: false, ignore: [] } }

/** Normalizes a folder path for exact matching (resolves symlinks where the path exists, else `path.resolve`). */
export function normalizeFolder(folder: string): string {
  const resolved = path.resolve(folder)
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

/** True when a session started in `folder` should auto-join the local bridge. Fails closed without a folder. */
export function shouldAutoJoin(config: BridgeConfig, folder: string | undefined): boolean {
  if (!config.autoJoin.enabled || !folder) return false
  const target = normalizeFolder(folder)
  // Stored entries are already normalized, so the string compare skips a realpath per entry in the common case.
  return !config.autoJoin.ignore.some(f => f === target || normalizeFolder(f) === target)
}

/** Returns a new config with auto-join switched on or off. */
export function setAutoJoin(config: BridgeConfig, enabled: boolean): BridgeConfig {
  return { ...config, autoJoin: { ...config.autoJoin, enabled } }
}

/** Returns a new config with `folder` added to the ignore list. */
export function ignoreAutoJoinFolder(config: BridgeConfig, folder: string): BridgeConfig {
  const norm = normalizeFolder(folder)
  const ignore = config.autoJoin.ignore.map(normalizeFolder)
  if (!ignore.includes(norm)) ignore.push(norm)
  return { ...config, autoJoin: { ...config.autoJoin, ignore } }
}

/** Returns a new config with `folder` removed from the ignore list. */
export function unignoreAutoJoinFolder(config: BridgeConfig, folder: string): BridgeConfig {
  const norm = normalizeFolder(folder)
  const ignore = config.autoJoin.ignore.map(normalizeFolder).filter(f => f !== norm)
  return { ...config, autoJoin: { ...config.autoJoin, ignore } }
}

/** Human-readable summary for `agent-bridge auto-join`. */
export function formatAutoJoin(config: BridgeConfig): string {
  const { enabled, ignore } = config.autoJoin
  const head = enabled ? 'auto-join: on.' : 'auto-join: off.'
  if (!ignore.length) return head
  return [head, 'Ignored folders:', ...ignore.map(f => `  ${f}`)].join('\n')
}

/** Loads `~/.agent-bridge/config.json`. Missing or invalid files fall back to defaults (never throws). */
export function loadConfig(file = CONFIG_FILE): BridgeConfig {
  try {
    const read = readJson(file, BridgeConfig)
    return read.status === 'ok' ? read.value : DEFAULT_CONFIG
  } catch {
    return DEFAULT_CONFIG
  }
}

/** Writes `~/.agent-bridge/config.json` atomically. */
export function saveConfig(config: BridgeConfig, file = CONFIG_FILE): void {
  if (file === CONFIG_FILE) ensureHome()
  writeJson(file, config, { pretty: true })
}
