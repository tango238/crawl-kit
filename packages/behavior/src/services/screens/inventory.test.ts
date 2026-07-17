import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectScreenInventory, resolveFrontendDir } from './inventory.js'

/** Create <dir> (recursively) and drop an empty file at <dir>/<file>. */
async function touch(dir: string, file: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, file), '', 'utf8')
}

describe('collectScreenInventory — App Router', () => {
  it('maps root page, route groups, params, catch-alls; skips slots and private dirs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inv-app-'))
    const app = join(root, 'app')
    await touch(app, 'page.tsx') // '/'
    await touch(join(app, 'about'), 'page.tsx') // '/about'
    await touch(join(app, '(marketing)', 'pricing'), 'page.tsx') // route group stripped → '/pricing'
    await touch(join(app, 'hotel', '[id]'), 'page.tsx') // '/hotel/:id'
    await touch(join(app, 'blog', '[...slug]'), 'page.tsx') // '/blog/:slug'
    await touch(join(app, 'shop', '[[...all]]'), 'page.tsx') // '/shop/:all'
    await touch(join(app, '@modal', 'photo'), 'page.tsx') // parallel-route slot → skipped
    await touch(join(app, '_components', 'widget'), 'page.tsx') // private dir → skipped
    await touch(join(app, 'nolayout'), 'layout.tsx') // no page.* → not a screen

    const inv = await collectScreenInventory(root)
    expect(inv?.source).toBe('nextjs-app-router')
    expect(inv?.screens.map((s) => s.path)).toEqual([
      '/',
      '/about',
      '/blog/:slug',
      '/hotel/:id',
      '/pricing',
      '/shop/:all',
    ])
  })
})

describe('collectScreenInventory — Pages Router', () => {
  it('used when app/ is absent; index→dir, params templated, _app/_document/_error and api/ skipped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inv-pages-'))
    const pages = join(root, 'pages')
    await touch(pages, 'index.tsx') // '/'
    await touch(pages, 'about.tsx') // '/about'
    await touch(pages, '_app.tsx') // skipped
    await touch(pages, '_document.tsx') // skipped
    await touch(pages, '_error.tsx') // skipped
    await touch(join(pages, 'blog'), 'index.tsx') // '/blog'
    await touch(join(pages, 'blog'), '[slug].tsx') // '/blog/:slug'
    await touch(join(pages, 'api', 'users'), 'list.tsx') // api/** skipped

    const inv = await collectScreenInventory(root)
    expect(inv?.source).toBe('nextjs-pages')
    expect(inv?.screens.map((s) => s.path)).toEqual(['/', '/about', '/blog', '/blog/:slug'])
  })

  it('prefers App Router when both app/ and pages/ exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inv-both-'))
    await touch(join(root, 'app'), 'page.tsx')
    await touch(join(root, 'pages'), 'legacy.tsx')
    const inv = await collectScreenInventory(root)
    expect(inv?.source).toBe('nextjs-app-router')
    expect(inv?.screens.map((s) => s.path)).toEqual(['/'])
  })
})

describe('collectScreenInventory — neither router', () => {
  it('returns null when there is no app/ or pages/ directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inv-none-'))
    await touch(join(root, 'src'), 'index.ts')
    expect(await collectScreenInventory(root)).toBeNull()
  })
})

describe('resolveFrontendDir', () => {
  it('returns null when no frontend repo is configured', () => {
    const dir = resolveFrontendDir('/nope', [{ name: 'api', url: 'https://x/api.git', role: 'backend' }])
    expect(dir).toBeNull()
  })

  it('prefers repo.path, then repo.name, then a local url — returning the first that exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inv-resolve-'))
    await mkdir(join(root, 'web-clone'), { recursive: true })

    // path is set but does not exist on disk → falls through to name
    const byName = resolveFrontendDir(root, [
      { name: 'web-clone', url: 'https://x/web.git', role: 'frontend', path: 'does-not-exist' },
    ])
    expect(byName).toBe(join(root, 'web-clone'))
  })

  it('falls back to a local (absolute path) url when neither path nor name exists', async () => {
    const localRepo = await mkdtemp(join(tmpdir(), 'inv-local-'))
    const root = await mkdtemp(join(tmpdir(), 'inv-resolve2-'))
    const dir = resolveFrontendDir(root, [{ name: 'ghost', url: localRepo, role: 'frontend' }])
    expect(dir).toBe(localRepo)
  })
})
