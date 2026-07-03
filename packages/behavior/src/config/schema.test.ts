import { describe, it, expect } from 'vitest'
import { ConfigSchema, WorkspaceConfigSchema, RepoSetupSchema } from './schema.js'

const valid = {
  repositories: [{ name: 'web', label: 'frontend-user', url: 'https://github.com/o/web', role: 'frontend', audience: 'user' }],
  targets: [{ name: 'staging', baseUrl: 'https://staging.example.com', auth: { strategy: 'none' } }],
  databases: [{ name: 'main', type: 'postgres', host: 'localhost', port: 5432, database: 'app', user: 'app', passwordEnv: 'DB_MAIN_PASSWORD' }],
  schedule: { intervalMinutes: 60 },
  scenarioDir: 'scenarios',
  github: { labels: { ready: 'Ready', autoDetect: 'Auto-Detect' } },
}

const baseValid = {
  repositories: [{ name: 'web', label: 'frontend-user', url: 'https://github.com/o/web', role: 'frontend', audience: 'user' }],
  targets: [{ name: 'local', baseUrl: 'http://localhost:3000', auth: { strategy: 'form', loginPath: '/login', usernameEnv: 'APP_USER', passwordEnv: 'APP_PASS' } }],
  databases: [],
  schedule: { intervalMinutes: 60 },
  scenarioDir: 'scenarios',
  github: { labels: { ready: 'Ready', autoDetect: 'Auto-Detect' } },
}

describe('ConfigSchema', () => {
  it('accepts a valid config', () => { expect(ConfigSchema.parse(valid)).toMatchObject(valid) })
  it('rejects invalid db type', () => {
    expect(() => ConfigSchema.parse({ ...valid, databases: [{ ...valid.databases[0], type: 'oracle' }] })).toThrow()
  })
  it('rejects intervalMinutes < 1', () => {
    expect(() => ConfigSchema.parse({ ...valid, schedule: { intervalMinutes: 0 } })).toThrow()
  })
  it('leaves language unset by default (consumer defaults to Japanese)', () => {
    expect(ConfigSchema.parse(valid).language).toBeUndefined()
  })
  it('accepts an explicit language', () => {
    expect(ConfigSchema.parse({ ...valid, language: 'en' }).language).toBe('en')
  })
  it('rejects an empty language string', () => {
    expect(() => ConfigSchema.parse({ ...valid, language: '' })).toThrow()
  })
})

describe('LaunchSchema', () => {
  it('accepts a valid launch config', () => {
    const cfg = ConfigSchema.parse({ ...baseValid, launch: {
      compose: { files: ['docker-compose.yml'], projectName: 'e2e' },
      readiness: { url: 'http://localhost:3000/login' },
      seed: { command: 'docker compose exec -T backend npm run seed:test' },
      targetName: 'local',
    } })
    expect(cfg.launch?.readiness.timeoutSec).toBe(180) // default
    expect(cfg.launch?.readiness.intervalSec).toBe(3)  // default
  })
  it('omits launch when not provided', () => {
    expect(ConfigSchema.parse(baseValid).launch).toBeUndefined()
  })
  it('rejects launch with empty compose.files', () => {
    expect(() => ConfigSchema.parse({ ...baseValid, launch: {
      compose: { files: [], projectName: 'e2e' }, readiness: { url: 'http://x' }, targetName: 'local',
    } })).toThrow()
  })
})

describe('branch + setup schema', () => {
  const base = {
    repositories: [{ name: 'web', label: 'frontend-user', url: 'https://github.com/o/web', role: 'frontend', audience: 'user' }],
    targets: [{ name: 'local', baseUrl: 'http://localhost:3000', auth: { strategy: 'none' } }],
    databases: [],
    schedule: { intervalMinutes: 60 },
    scenarioDir: 'scenarios',
    github: { labels: { ready: 'Ready', autoDetect: 'Auto-Detect' } },
  }

  it('accepts optional repo branch and setup commands', () => {
    const cfg = ConfigSchema.parse({
      ...base,
      repositories: [{ ...base.repositories[0], branch: 'main' }],
      setup: [{ command: 'echo hi' }, { command: 'docker compose exec -T app true' }],
    })
    expect(cfg.repositories[0].branch).toBe('main')
    expect(cfg.setup?.length).toBe(2)
  })
  it('omits branch and setup when not provided', () => {
    const cfg = ConfigSchema.parse(base)
    expect(cfg.repositories[0].branch).toBeUndefined()
    expect(cfg.setup).toBeUndefined()
  })
  it('rejects a setup entry with empty command', () => {
    expect(() => ConfigSchema.parse({ ...base, setup: [{ command: '' }] })).toThrow()
  })
})

describe('grow schema', () => {
  const base = {
    repositories: [{ name: 'web', label: 'l', url: 'https://github.com/o/web', role: 'frontend', audience: 'user' }],
    targets: [{ name: 'local', baseUrl: 'http://localhost:3000', auth: { strategy: 'form', loginPath: '/login', usernameEnv: 'U', passwordEnv: 'P' } }],
    databases: [], schedule: { intervalMinutes: 60 }, scenarioDir: 'scenarios',
    github: { labels: { ready: 'Ready', autoDetect: 'Auto-Detect' } },
  }

  it('applies grow config defaults', () => {
    const cfg = ConfigSchema.parse({ ...base, grow: {} })
    expect(cfg.grow?.maxPages).toBe(50)   // default
    expect(cfg.grow?.maxDepth).toBe(3)    // default
  })
  it('omits grow when absent', () => {
    expect(ConfigSchema.parse(base).grow).toBeUndefined()
  })
  // 2FA is no longer a config concept — it lives on the login scenario (scenario.twoFactor).
})

describe('WorkspaceConfigSchema', () => {
  it('fills workspace defaults from a minimal config', () => {
    const c = WorkspaceConfigSchema.parse({
      repositories: [{ name: 'backend', label: 'BE', url: 'https://example.com/r.git', role: 'backend', audience: 'user' }],
    })
    expect(c.maxParallel).toBe(3)
    expect(c.regenerateTtlSeconds).toBe(86400)
    expect(c.scenarioDir).toBe('scenarios')
    expect(c.targets).toEqual([])
    expect(c.databases).toEqual([])
    expect(c.schedule.intervalMinutes).toBe(60)
  })

  it('accepts an optional clone path per repository', () => {
    const c = WorkspaceConfigSchema.parse({
      repositories: [{ name: 'be', label: 'BE', url: 'https://example.com/r.git', role: 'backend', audience: 'user', path: 'services/be' }],
    })
    expect(c.repositories[0]!.path).toBe('services/be')
  })
})

describe('RepoSetupSchema', () => {
  it('parses a full repo setup document', () => {
    const r = RepoSetupSchema.parse({
      framework: 'laravel',
      structure: { summary: 'routes/web.php + app/Http/Controllers', routingDirs: ['routes'], controllerDirs: ['app/Http/Controllers'], modelDirs: ['app/Models'] },
      devServer: { command: 'php artisan serve', port: 8000 },
      dbAccess: { source: '.env', envFile: '.env' },
      claudeMd: { present: false, source: 'auto-analysis' },
    })
    expect(r.framework).toBe('laravel')
  })
})
