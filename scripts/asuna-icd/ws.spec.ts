/** SES-8: workspaces, one per folder, ordered, and sessions archived and unarchived (README.md, SES-8). */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../packages/storage/storage-domain/tests/helpers/memory-backend.ts'
import { scratch } from './harness.ts'

let ctx: Context | undefined
let folder: { root: string; remove: () => void } | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  folder?.remove()
  ctx = undefined
  folder = undefined
})

/** The registry over DSH's storage domain, with persisted sessions listed from these headers. */
async function registry(headers: SessionHeader[]) {
  ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve(headers.map(header => ({ header, revision: SessionPersistenceRevision(`rev-${header.id}`) }))),
    open: () => { throw new Error('not used') },
    stat: () => { throw new Error('not used') },
  } as never)
  await ctx.plugin(SessionStore)
  await ctx.plugin(WorkspaceRegistry)
  return ctx.workspaceRegistry
}

describe('SES. Workspaces', () => {
  it('SES-8 one workspace per folder, ordered and deletable; a session is attached, archived and unarchived', async () => {
    folder = scratch()
    const [local, channel] = ['local', 'channel'].map((name) => {
      const at = join(folder!.root, name)
      mkdirSync(at)
      return at
    }) as [string, string]
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('ws-session'), createdAt: 0, isSeeded: false, cwd: channel }
    const workspaces = await registry([header])

    const first = await workspaces.create(local, 'Local')
    const again = await workspaces.create(local, 'Local')
    expect(again.id).toBe(first.id)
    const second = await workspaces.create(channel, 'Channel')
    await workspaces.insertBefore(second.id, first.id)
    expect(workspaces.list().map(workspace => workspace.id).slice(0, 2)).toEqual([second.id, first.id])

    await workspaces.archiveSession(SessionId('ws-session'))
    await workspaces.unarchiveSession(SessionId('ws-session'))
    expect(await workspaces.delete(first.id)).toBe(true)
    expect(workspaces.list().map(workspace => workspace.id)).not.toContain(first.id)
  })
})
