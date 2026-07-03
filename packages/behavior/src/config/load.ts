import { existsSync } from 'node:fs'
import { join } from 'node:path'
import dotenv from 'dotenv'
import { readYaml } from '../util/fs.js'
import type { Secrets } from '../domain/types.js'
import {
  CONFIG_FILENAME,
  ConfigSchema,
  WORKSPACE_CONFIG_RELPATH,
  WorkspaceConfigSchema,
  type Config,
  type WorkspaceConfig,
} from './schema.js'

/** Default GitHub label config used when workspace.yaml has no `github` section. */
const GITHUB_DEFAULT = { labels: { ready: 'ready', autoDetect: 'auto-detect' } }

/** Resolve db/auth env vars referenced by a config. Missing names are RETURNED, not thrown. */
function resolveSecrets(config: Pick<Config, 'databases' | 'targets'>): {
  secrets: Secrets
  missing: string[]
} {
  const dbSecrets: Record<string, string> = {}
  const targetAuthSecrets: Record<string, string> = {}
  const missing: string[] = []

  for (const db of config.databases) {
    const value = process.env[db.passwordEnv]
    if (!value) missing.push(db.passwordEnv)
    else dbSecrets[db.passwordEnv] = value
  }
  for (const target of config.targets) {
    for (const envName of [target.auth?.usernameEnv, target.auth?.passwordEnv]) {
      if (!envName) continue
      const value = process.env[envName]
      if (!value) missing.push(envName)
      else targetAuthSecrets[envName] = value
    }
  }
  return {
    secrets: {
      db: dbSecrets,
      targetAuth: targetAuthSecrets,
      anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? '',
      githubToken: process.env['GITHUB_TOKEN'] ?? '',
    },
    missing,
  }
}

export async function loadConfig(root: string): Promise<{ config: Config; secrets: Secrets }> {
  // Load .env from the project root so env vars are available for secret resolution
  dotenv.config({ path: join(root, '.env'), quiet: true })

  // Fall back to .crawl-kit/workspace.yaml (P1) when e2e.config.yaml is absent, so behavior
  // CLI commands (loop-e2e) can run with a fresh `crawl-kit setup` workspace as cwd.
  if (!existsSync(join(root, CONFIG_FILENAME)) && existsSync(join(root, WORKSPACE_CONFIG_RELPATH))) {
    const { config: ws, secrets, missingEnv } = await loadWorkspaceConfig(root)
    if (missingEnv.length > 0) {
      throw new Error(`Missing required environment variables: ${missingEnv.join(', ')}`)
    }
    // NOTE: intentionally NOT re-validated via ConfigSchema.parse — ConfigSchema enforces
    // targets.min(1), which a freshly-`setup` workspace (no targets configured yet) would fail.
    // WorkspaceConfig is a structural superset of Config (github optional, looser array
    // minimums), so the projection below is sound without re-parsing.
    const config: Config = { ...ws, github: ws.github ?? GITHUB_DEFAULT }
    return { config, secrets }
  }

  const raw = await readYaml<unknown>(join(root, CONFIG_FILENAME))
  const config = ConfigSchema.parse(raw)

  const { secrets, missing } = resolveSecrets(config)
  const dedupedMissing = [...new Set(missing)]

  if (dedupedMissing.length > 0) {
    throw new Error(`Missing required environment variables: ${dedupedMissing.join(', ')}`)
  }

  return { config, secrets }
}

/**
 * Load .crawl-kit/workspace.yaml. Missing env vars are reported, not fatal —
 * doctor surfaces them and commands that need them fail at point of use.
 */
export async function loadWorkspaceConfig(root: string): Promise<{
  config: WorkspaceConfig
  secrets: Secrets
  missingEnv: string[]
}> {
  dotenv.config({ path: join(root, '.env'), quiet: true })
  const raw = await readYaml<unknown>(join(root, WORKSPACE_CONFIG_RELPATH))
  const config = WorkspaceConfigSchema.parse(raw)
  const { secrets, missing } = resolveSecrets(config)
  return { config, secrets, missingEnv: [...new Set(missing)] }
}
