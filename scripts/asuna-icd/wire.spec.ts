/**
 * What leaves this computer: requests as a real adapter writes them to a model server on loopback (README.md, LLM-1
 * and SES-6). The server answers 401, so each request is captured and nothing is generated.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits, ImageAttachmentRef, ImageRequestTarget, RequestImageAttachment, SaveImageAttachment, StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { scratch } from './harness.ts'

const HOST_PATH = '/real/local/root/.dsh/attachments/objects/aa/object'
const CONTRACTED = '${ROOT}/.dsh/attachments/objects/aa/object'
const IMAGE: ImageAttachmentRef = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', bytes: 1, width: 1, height: 1 }

/** The table of the request being built now, as Asuna's roots.js keeps it. */
const scope = new AsyncLocalStorage<string>()

class Attachments extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 4096, maxImagePixels: 4096, maxImageDimension: 2000,
    mediaTypes: ['image/png'],
  }

  validateImage(_input: SaveImageAttachment): Promise<void> { return Promise.resolve() }
  saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> { return Promise.reject(new Error('not used')) }
  readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> { return Promise.resolve({ ref, data: Uint8Array.of(1) }) }
  override imageHostPath(_ref: ImageAttachmentRef): string { return HOST_PATH }
  override readImageRequest(value: ImageAttachmentRef, _target: ImageRequestTarget): Promise<RequestImageAttachment> {
    return Promise.resolve({
      variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`), attachment: value, data: Uint8Array.of(1), mediaType: value.mediaType,
      bytes: 1, width: value.width, height: value.height, depth: 'uchar', space: 'srgb', hasAlpha: true,
    })
  }
}

/** The filesystem mapping Asuna wraps (roots.js wrapHostPaths): contracted inside her scope, unchanged outside it. */
class FileSystem extends Service {
  constructor(ctx: Context) { super(ctx, 'fs') }
  processPathFromHostPath(hostPath: string): string | undefined {
    const table = scope.getStore()
    return table === undefined ? hostPath : hostPath.replace('/real/local/root', table)
  }
}

let server: Server | undefined
let ctx: Context | undefined
let home: { root: string; remove: () => void } | undefined
afterEach(async () => {
  vi.unstubAllEnvs()
  await ctx?.fiber.dispose()
  home?.remove()
  home = undefined
  await new Promise<void>((resolve) => {
    if (server) server.close(() => { resolve() })
    else resolve()
  })
  server?.closeAllConnections()
  server = undefined
  ctx = undefined
})

async function modelServer(): Promise<{ url: string; bodies: string[] }> {
  const bodies: string[] = []
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'captured' } }))
    })
  })
  await new Promise<void>((resolve) => { server!.listen(0, '127.0.0.1', resolve) })
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies }
}

/** The two adapters her routes use: pi-ai (a server of the operator's own) and DeepSeek's. */
const ADAPTERS = {
  'pi-ai': async (target: Context, url: string) => {
    vi.stubEnv('ICD_TEST_KEY', 'test-key')
    await target.plugin(LlmPiAi, { providers: { openai: { apiKeyEnv: 'ICD_TEST_KEY', baseURL: url } } })
    return { provider: 'openai', model: 'gpt-4.1' }
  },
  'deepseek': async (target: Context, url: string) => {
    home = scratch()
    vi.stubEnv('DSH_HOME', home.root)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    await target.plugin(DeepSeekLlmApiExtensionRegistry)
    await target.plugin(LlmDeepSeek, { baseURL: url, models: [{ id: 'm', inputModalities: ['text', 'image'] }] })
    return { provider: 'deepseek-official', model: 'm' }
  },
} as const

async function send(adapter: keyof typeof ADAPTERS, message: UserMessage, inScope: boolean): Promise<string[]> {
  const { url, bodies } = await modelServer()
  ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const route = await ADAPTERS[adapter](ctx, url)
  await ctx.plugin(Attachments)
  await ctx.plugin(FileSystem)
  if (inScope) {
    ctx.on('llm/stream', (_options, next) => (async function* () {
      const it = scope.run('${ROOT}', next)[Symbol.asyncIterator]()
      for (;;) {
        const step = await scope.run('${ROOT}', () => it.next())
        if (step.done) return
        yield step.value
      }
    })(), { global: true })
  }
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream({ ...route, sessionId: 'wire', messages: [message] } as unknown as GenerateOptions)) {
    chunks.push(chunk)
  }
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
  return bodies
}

describe.each(Object.keys(ADAPTERS) as (keyof typeof ADAPTERS)[])('What leaves this computer through %s', (adapter) => {
  const picture = () => createUserMessage({
    content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: IMAGE }],
    source: { kind: 'user' },
  })

  it('LLM-1 the image note a real adapter writes carries the path mapped inside the caller\'s async context', async () => {
    const scoped = (await send(adapter, picture(), true)).join('\n')
    expect(scoped).toContain(CONTRACTED)
    expect(scoped).not.toContain('/real/local/root')
  })

  it('LLM-1 without that context the same note carries the real path (the control)', async () => {
    expect((await send(adapter, picture(), false)).join('\n')).toContain(HOST_PATH)
  })

  it('SES-6 a user message\'s source fields are not written to the model server', async () => {
    const message = createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user', channel: 'qq', receipt: 'RECEIPT-77', sender: 'SENDER-9', trigger: 'TRIGGER-1' } as never,
    })
    const wire = (await send(adapter, message, false)).join('\n')
    expect(wire).toContain('hello')
    for (const value of ['RECEIPT-77', 'SENDER-9', 'TRIGGER-1']) expect(wire).not.toContain(value)
  })
})
