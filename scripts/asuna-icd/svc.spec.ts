/** SVC: web providers, credentials, image attachments and spilled output (README.md, SVC). */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { saveTextFile, sessionDir } from '@deepseek-ai/dsh-spill-local'
import WebRuntime from '@deepseek-ai/dsh-web'
import { DEFAULT_USER_AGENT, HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { scratch } from './harness.ts'

const LIMITS = { maxResponseBytes: 5_000_000, maxBodyChars: 5_000_000, timeoutMs: 30_000, maxRedirects: 5, userAgent: DEFAULT_USER_AGENT }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

let ctx: Context | undefined
let folder: { root: string; remove: () => void } | undefined
let server: Server | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  if (server) {
    await new Promise<void>((resolve) => { server!.close(() => { resolve() }) })
    server.closeAllConnections()
  }
  folder?.remove()
  ctx = undefined
  folder = undefined
  server = undefined
})

async function localPage(): Promise<string> {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('lan ok')
  })
  await new Promise<void>((resolve) => { server!.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
}

describe('SVC. Host services', () => {
  it('SVC-1 a plugin\'s own search and fetch providers are chosen by id, and the registered search providers can be listed', async () => {
    ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: 'icd-search', fetchProvider: 'icd-fetch' })
    ctx.web.registerSearchProvider({ id: 'other-search', available: () => true, search: () => Promise.resolve({ sources: [], truncated: false, content: 'other' }) })
    ctx.web.registerSearchProvider({ id: 'icd-search', available: () => true,
      search: ({ query }) => Promise.resolve({ sources: [], truncated: false, content: `own answer to ${query}` }) })
    ctx.web.registerFetchProvider({ id: 'icd-fetch', available: () => true,
      fetch: ({ url }) => Promise.resolve({ url, statusCode: 200, body: { kind: 'text', content: 'own fetch' }, truncated: false }) })

    expect((await ctx.web.search({ query: 'q', maxResults: 5 })).content).toBe('own answer to q')
    expect((await ctx.web.fetch({ url: 'https://page.example/' })).body).toMatchObject({ content: 'own fetch' })
    const registered = (ctx.web as unknown as { searchProviders?: unknown }).searchProviders
    expect(registered).toBeInstanceOf(Map)
    expect([...(registered as Map<string, unknown>).keys()]).toEqual(expect.arrayContaining(['icd-search', 'other-search']))
  })

  it('SVC-1 a plugin\'s fetch provider uses DSH\'s HTTP fetch for the transfer and its result', async () => {
    const url = await localPage()
    // Binding on rc.5: DSH's own resolver refuses this loopback page, so the spec passes one that admits it. On 0.2.2
    // the resolver is gone and `new HttpFetchProvider(LIMITS)` reaches the page; the address policy is the plugin's.
    const fetcher = new HttpFetchProvider(LIMITS, host => Promise.resolve([{ address: host === 'localhost' ? '127.0.0.1' : host, family: 4 }]))
    const fetched = await fetcher.fetch({ url })
    expect(fetched).toMatchObject({ url, statusCode: 200, body: { kind: 'text', content: 'lan ok' } })
  })

  it('SVC-2 credential records with any payload live under a plugin\'s own key prefix; secret references resolve', async () => {
    folder = scratch()
    ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { dshHome: folder.root, watch: false })
    const store = ctx.credentials
    const key = credentialKey('asuna-cognition-core', 'mail')
    expect(key).toBe('asuna-cognition-core/mail')
    await store.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: { note: 'her note', env: 'MAIL_TOKEN' } }))
    expect((await store.listRecords()).map(row => row.key)).toContain(key)
    expect(((await store.readRecord(key)) as { payload?: unknown } | undefined)?.payload).toEqual({ note: 'her note', env: 'MAIL_TOKEN' })
    await store.deleteRecord(key)
    expect((await store.listRecords()).map(row => row.key)).not.toContain(key)
    await store.set(credentialRef('ICD_SECRET'), 'secret value')
    expect((await store.resolve(credentialRef('ICD_SECRET')))?.value).toBe('secret value')
  })

  it('SVC-4 an image is saved as an attachment with its id, type and size, and read back', async () => {
    folder = scratch()
    ctx = new Context()
    await ctx.plugin(LocalAttachmentStore, { dshHome: folder.root })
    const ref = await ctx.attachments.saveImage({ data: PNG, mediaType: 'image/png', name: 'dot.png' })
    expect(ref).toMatchObject({ attachmentId: expect.stringMatching(/^sha256:/) as string, mediaType: 'image/png', width: 1, height: 1 })
    expect((await ctx.attachments.readImage(ref)).data.byteLength).toBeGreaterThan(0)
  })

  it('SVC-5 spilled output of a session is a file in that session\'s own spill folder', async () => {
    folder = scratch()
    const saved = await saveTextFile({ root: folder.root, sessionId: 'svc-5', suggestedName: 'output.txt', content: 'long output' })
    expect(dirname(saved.path)).toBe(sessionDir(folder.root, 'svc-5'))
    expect(dirname(sessionDir(folder.root, 'svc-5'))).toBe(folder.root)
  })
})

describe('SVC. Gateway methods of a plugin', () => {
  it('SVC-6 the remote service base and the method marker Asuna applies by hand are exported', () => {
    expect(typeof TypertRemoteService).toBe('function')
    expect(typeof Remote).toBe('function')
  })
})
