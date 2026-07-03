import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from './save.js'
import { loadConfig, loadWorkspaceConfig } from './load.js'
import type { Config } from './schema.js'

// A valid config fixture matching ConfigSchema requirements.
// The `prod` target uses form auth with both usernameEnv and passwordEnv.
const valid: Config = {
  repositories: [{ name: 'web', label: 'frontend-user', url: 'https://github.com/o/web', role: 'frontend', audience: 'user' }],
  targets: [
    { name: 'staging', baseUrl: 'https://staging.example.com', auth: { strategy: 'none' } },
    { name: 'prod', baseUrl: 'https://prod.example.com', auth: { strategy: 'form', loginPath: '/login', usernameEnv: 'PROD_USER', passwordEnv: 'PROD_PASSWORD' } },
  ],
  databases: [{ name: 'main', type: 'postgres', host: 'localhost', port: 5432, database: 'app', user: 'app', passwordEnv: 'DB_MAIN_PASSWORD' }],
  schedule: { intervalMinutes: 60 },
  scenarioDir: 'scenarios',
  github: { labels: { ready: 'Ready', autoDetect: 'Auto-Detect' } },
  baseline: { commit: false },
  models: { planning: 'claude-opus-4-8', report: 'claude-sonnet-4-6', verification: 'claude-opus-4-8' },
  ingestion: { cloneDepth: 50, tokenBudgetPerRepo: 120000, gitLogCount: 50 },
  refutation: { panelSize: 3, confidenceThreshold: 0.8, lenses: ['correctness', 'security', 'intentionality'] },
}

// All referenced required env vars (db password + target auth username/password).
const FULL_ENV = 'DB_MAIN_PASSWORD=secret\nPROD_USER=produser\nPROD_PASSWORD=prodpass\nANTHROPIC_API_KEY=ant-key\nGITHUB_TOKEN=gh-token\n'

describe('loadConfig', () => {
  let dir: string
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'le2e-'))
    // Save a snapshot of env so we can restore it after each test
    originalEnv = { ...process.env }
  })

  afterEach(async () => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips config and resolves secrets', async () => {
    await saveConfig(dir, valid)
    await writeFile(join(dir, '.env'), FULL_ENV)

    const { config, secrets } = await loadConfig(dir)
    expect(config.scenarioDir).toBe('scenarios')
    expect(secrets.db['DB_MAIN_PASSWORD']).toBe('secret')
    expect(secrets.targetAuth['PROD_USER']).toBe('produser')
    expect(secrets.targetAuth['PROD_PASSWORD']).toBe('prodpass')
    expect(secrets.anthropicApiKey).toBe('ant-key')
    expect(secrets.githubToken).toBe('gh-token')
  })

  it('throws a clear error when a required db env var is missing (no secret value in message)', async () => {
    await saveConfig(dir, valid)
    // Write .env without DB_MAIN_PASSWORD
    await writeFile(join(dir, '.env'), 'PROD_USER=produser\nPROD_PASSWORD=prodpass\nANTHROPIC_API_KEY=ant-key\nGITHUB_TOKEN=gh-token\n')
    delete process.env['DB_MAIN_PASSWORD']

    await expect(loadConfig(dir)).rejects.toThrow('DB_MAIN_PASSWORD')
  })

  it('resolves target auth username AND password into secrets.targetAuth', async () => {
    await saveConfig(dir, valid)
    await writeFile(join(dir, '.env'), FULL_ENV)

    const { secrets } = await loadConfig(dir)
    expect(secrets.targetAuth['PROD_USER']).toBe('produser')
    expect(secrets.targetAuth['PROD_PASSWORD']).toBe('prodpass')
  })

  it('throws listing a referenced target usernameEnv when it is missing', async () => {
    await saveConfig(dir, valid)
    // PROD_USER is referenced by the prod target's auth but absent from .env
    await writeFile(join(dir, '.env'), 'DB_MAIN_PASSWORD=secret\nPROD_PASSWORD=prodpass\nANTHROPIC_API_KEY=ant-key\nGITHUB_TOKEN=gh-token\n')
    delete process.env['PROD_USER']

    await expect(loadConfig(dir)).rejects.toThrow('PROD_USER')
  })

  it('error message never contains a secret value (secret-leak regression guard)', async () => {
    await saveConfig(dir, valid)
    // DB_MAIN_PASSWORD missing triggers the error; other secrets are present and must not leak.
    await writeFile(join(dir, '.env'), 'PROD_USER=produser\nPROD_PASSWORD=prodpass\nANTHROPIC_API_KEY=supersecret\nGITHUB_TOKEN=ghsecret\n')
    delete process.env['DB_MAIN_PASSWORD']

    let err: Error | undefined
    try {
      await loadConfig(dir)
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeDefined()
    expect(err!.message).toContain('DB_MAIN_PASSWORD')
    expect(err!.message).not.toContain('supersecret')
    expect(err!.message).not.toContain('prodpass')
  })

  it('treats ANTHROPIC_API_KEY as optional — resolves to empty string when absent', async () => {
    await saveConfig(dir, valid)
    await writeFile(join(dir, '.env'), 'DB_MAIN_PASSWORD=secret\nPROD_USER=produser\nPROD_PASSWORD=prodpass\nGITHUB_TOKEN=gh-token\n')
    delete process.env['ANTHROPIC_API_KEY']

    const { secrets } = await loadConfig(dir)
    expect(secrets.anthropicApiKey).toBe('')
    expect(secrets.githubToken).toBe('gh-token')
  })

  it('treats GITHUB_TOKEN as optional — resolves to empty string when absent', async () => {
    await saveConfig(dir, valid)
    await writeFile(join(dir, '.env'), 'DB_MAIN_PASSWORD=secret\nPROD_USER=produser\nPROD_PASSWORD=prodpass\nANTHROPIC_API_KEY=ant-key\n')
    delete process.env['GITHUB_TOKEN']

    const { secrets } = await loadConfig(dir)
    expect(secrets.githubToken).toBe('')
    expect(secrets.anthropicApiKey).toBe('ant-key')
  })

  it('loads successfully with neither service key set (launch/login-only use)', async () => {
    await saveConfig(dir, valid)
    await writeFile(join(dir, '.env'), 'DB_MAIN_PASSWORD=secret\nPROD_USER=produser\nPROD_PASSWORD=prodpass\n')
    delete process.env['ANTHROPIC_API_KEY']
    delete process.env['GITHUB_TOKEN']

    const { secrets } = await loadConfig(dir)
    expect(secrets.anthropicApiKey).toBe('')
    expect(secrets.githubToken).toBe('')
    // referenced login + db secrets are still resolved
    expect(secrets.targetAuth['PROD_USER']).toBe('produser')
    expect(secrets.db['DB_MAIN_PASSWORD']).toBe('secret')
  })
})

describe('loadWorkspaceConfig', () => {
  async function makeWorkspace(yaml: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ck-wcfg-'))
    await mkdir(join(root, '.crawl-kit'), { recursive: true })
    await writeFile(join(root, '.crawl-kit', 'workspace.yaml'), yaml, 'utf8')
    return root
  }

  it('loads workspace.yaml and lists missing env vars without throwing', async () => {
    delete process.env['CK_TEST_DB_PW']
    const root = await makeWorkspace(
      [
        'repositories:',
        '  - { name: be, label: BE, url: "https://example.com/r.git", role: backend, audience: user }',
        'databases:',
        '  - { name: main, type: postgres, host: localhost, port: 5432, database: app, user: app, passwordEnv: CK_TEST_DB_PW }',
      ].join('\n'),
    )
    const { config, missingEnv } = await loadWorkspaceConfig(root)
    expect(config.maxParallel).toBe(3)
    expect(missingEnv).toContain('CK_TEST_DB_PW')
  })

  it('resolves env vars that are present', async () => {
    process.env['CK_TEST_DB_PW'] = 'pw'
    const root = await makeWorkspace(
      [
        'repositories:',
        '  - { name: be, label: BE, url: "https://example.com/r.git", role: backend, audience: user }',
        'databases:',
        '  - { name: main, type: postgres, host: localhost, port: 5432, database: app, user: app, passwordEnv: CK_TEST_DB_PW }',
      ].join('\n'),
    )
    const { secrets, missingEnv } = await loadWorkspaceConfig(root)
    expect(missingEnv).toEqual([])
    expect(secrets.db['CK_TEST_DB_PW']).toBe('pw')
    delete process.env['CK_TEST_DB_PW']
  })
})

describe('loadConfig workspace fallback', () => {
  it('falls back to .crawl-kit/workspace.yaml when e2e.config.yaml is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ck-fb-'))
    await mkdir(join(root, '.crawl-kit'), { recursive: true })
    await writeFile(join(root, '.crawl-kit', 'workspace.yaml'), [
      'repositories:',
      '  - { name: be, label: BE, url: "https://example.com/r.git", role: backend, audience: user }',
    ].join('\n'), 'utf8')
    const { config } = await loadConfig(root)
    expect(config.github.labels.ready).toBe('ready') // 補完される
    expect(config.scenarioDir).toBe('scenarios')
    await rm(root, { recursive: true, force: true })
  })

  it('still throws on missing env vars in workspace fallback mode', async () => {
    delete process.env['CK_FB_PW']
    const root = await mkdtemp(join(tmpdir(), 'ck-fb2-'))
    await mkdir(join(root, '.crawl-kit'), { recursive: true })
    await writeFile(join(root, '.crawl-kit', 'workspace.yaml'), [
      'repositories:',
      '  - { name: be, label: BE, url: "https://example.com/r.git", role: backend, audience: user }',
      'databases:',
      '  - { name: m, type: postgres, host: h, port: 5432, database: d, user: u, passwordEnv: CK_FB_PW }',
    ].join('\n'), 'utf8')
    await expect(loadConfig(root)).rejects.toThrow(/CK_FB_PW/)
    await rm(root, { recursive: true, force: true })
  })

  it('prefers e2e.config.yaml when both exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ck-fb3-'))
    await saveConfig(root, valid)
    await writeFile(join(root, '.env'), FULL_ENV)
    await mkdir(join(root, '.crawl-kit'), { recursive: true })
    await writeFile(join(root, '.crawl-kit', 'workspace.yaml'), [
      'repositories:',
      '  - { name: be, label: BE, url: "https://example.com/r.git", role: backend, audience: user }',
      'scenarioDir: workspace-scenarios',
    ].join('\n'), 'utf8')

    const { config, secrets } = await loadConfig(root)
    // e2e.config.yaml's scenarioDir ("scenarios") wins over workspace.yaml's ("workspace-scenarios")
    expect(config.scenarioDir).toBe('scenarios')
    expect(config.github.labels.ready).toBe('Ready') // e2e.config.yaml's own github value, not the fallback default
    expect(secrets.db['DB_MAIN_PASSWORD']).toBe('secret')
    await rm(root, { recursive: true, force: true })
  })
})
