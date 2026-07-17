import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { installUnhandledRejectionGuard } from './unhandledGuard.js'

function fakeProcess(): NodeJS.Process {
  return new EventEmitter() as unknown as NodeJS.Process
}

describe('installUnhandledRejectionGuard', () => {
  it('registers a listener that swallows a rejection without throwing', () => {
    const proc = fakeProcess()
    installUnhandledRejectionGuard(proc)
    expect(proc.listenerCount('unhandledRejection')).toBe(1)
    expect(() => proc.emit('unhandledRejection', new Error('claude CLI exited with code 1'), Promise.resolve())).not.toThrow()
  })

  it('is idempotent — a second install does not stack listeners', () => {
    const proc = fakeProcess()
    installUnhandledRejectionGuard(proc)
    installUnhandledRejectionGuard(proc)
    expect(proc.listenerCount('unhandledRejection')).toBe(1)
  })

  it('does not install over an existing handler', () => {
    const proc = fakeProcess()
    const existing = vi.fn()
    proc.on('unhandledRejection', existing)
    installUnhandledRejectionGuard(proc)
    expect(proc.listenerCount('unhandledRejection')).toBe(1)
  })
})
