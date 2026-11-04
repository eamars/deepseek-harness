/** LLM: the one rewrite point every model request passes, and model failures (README.md, LLM). */
import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import LlmRuntime, { BlockAssembler, createUserMessage, isAgentLoopRequest, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { host, MODEL, open, person, ScriptedModel, text } from './harness.ts'

let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

const REWRITTEN = Symbol('icd.rewritten')
const sent = (options: GenerateOptions): string => JSON.stringify({ system: options.system, messages: options.messages })

/** Rewrite every text block, as Asuna rewrites local paths (roots.js rewriteRequest). */
function rewrite(options: GenerateOptions, from: string, to: string): GenerateOptions {
  const messages = options.messages.map(message => ({
    ...message,
    content: (message.content as readonly { type: string; text?: string }[]).map(block =>
      (block.type === 'text' && block.text !== undefined ? { ...block, text: block.text.replaceAll(from, to) } : block)),
  })) as GenerateOptions['messages']
  const request = { ...options, messages, [REWRITTEN]: true } as GenerateOptions
  if (isAgentLoopRequest(options)) markAgentLoopRequest(request)
  return request
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('LLM. Models', () => {
  it('LLM-1 agent steps and hand-built calls pass one global waterfall, where a rewrite re-enters it and keeps the agent-loop mark', async () => {
    const run = await host(new ScriptedModel([text('step'), text('one-shot')]))
    ctx = run.ctx
    const seen: { sessionId: string | undefined; loop: boolean; rewritten: boolean }[] = []
    ctx.on('llm/stream', (options, next) => {
      seen.push({ sessionId: options.sessionId, loop: isAgentLoopRequest(options), rewritten: REWRITTEN in options })
      if (REWRITTEN in options) return next()
      return ctx!.llm.stream(rewrite(options, '/real/local/root', '${ROOT}'))
    }, { global: true })

    const agent = await open(ctx, 'llm-1')
    agent.followup(person('read /real/local/root/notes.txt'))
    await agent.whenIdle()
    await drain(ctx.llm.stream({ ...MODEL, sessionId: 'llm-1-oneshot', messages: [createUserMessage({
      content: [{ type: 'text', text: 'one-shot about /real/local/root' }], source: { kind: 'user' },
    })] } as unknown as GenerateOptions))

    expect(seen.filter(s => !s.rewritten).map(s => s.sessionId)).toEqual(['llm-1', 'llm-1-oneshot'])
    expect(seen.filter(s => s.rewritten).map(s => s.loop)).toEqual([true, false])
    expect(run.model.requests.map(sent).join('\n')).not.toContain('/real/local/root')
    expect(sent(run.model.requests[0]!)).toContain('${ROOT}/notes.txt')
    expect(agent.session.snapshotEvents().some(e => e.type === 'turn/end')).toBe(true)
  })

  it('LLM-1 a local path DSH writes into a request after the waterfall (a file handle) is mapped inside the caller\'s async context', async () => {
    const run = await host(new ScriptedModel([text('ok')]))
    ctx = run.ctx
    const scope = new AsyncLocalStorage<string>()
    const calls: (string | undefined)[] = []
    ctx.provide('attachments')
    ctx.provide('fs')
    ;(ctx as unknown as Record<string, unknown>).attachments = { fileHostPath: () => '/real/local/root/upload.bin' }
    ;(ctx as unknown as Record<string, unknown>).fs = {
      processPathFromHostPath(hostPath: string) {
        const table = scope.getStore()
        calls.push(table)
        return table === undefined ? hostPath : hostPath.replace('/real/local/root', table)
      },
    }
    ctx.on('llm/stream', (_options, next) => (async function* () {
      const it = scope.run('${ROOT}', next)[Symbol.asyncIterator]()
      for (;;) {
        const step = await scope.run('${ROOT}', () => it.next())
        if (step.done) return
        yield step.value
      }
    })(), { global: true })

    const agent = await open(ctx, 'llm-1-file')
    agent.followup(createUserMessage({ content: [
      { type: 'text', text: 'here is a file' },
      { type: 'file', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'upload.bin', bytes: 3, mediaType: 'application/octet-stream' } },
    ] as never, source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(table => table === '${ROOT}')).toBe(true)
    expect(sent(run.model.requests[0]!)).toContain('${ROOT}/upload.bin')
    expect(sent(run.model.requests[0]!)).not.toContain('/real/local/root')
  })

  it('LLM-4 DSH\'s model runtime and adapters still produce each failure code Asuna routes on', () => {
    const llm = fileURLToPath(new URL('../../packages/llm/', import.meta.url))
    const sources = readdirSync(llm).flatMap((pkg) => {
      const src = join(llm, pkg, 'src')
      return existsSync(src) ? readdirSync(src, { recursive: true, encoding: 'utf8' }).map(file => join(src, file)) : []
    }).filter(file => file.endsWith('.ts')).map(file => readFileSync(file, 'utf8')).join('\n')
    for (const code of ['AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'RATE_LIMIT', 'SERVER', 'TIMEOUT',
      'TRANSPORT', 'STREAM_CLOSED', 'ABORTED', 'CONTEXT_WINDOW_EXCEEDED', 'INVALID_REQUEST']) {
      expect(sources, code).toContain(`'${code}'`)
    }
  })
})

describe('LLM. Model catalog and a plugin\'s own call', () => {
  it('LLM-2 a configured model\'s window, output cap, input kinds and efforts are readable, and providers and models are listed', async () => {
    vi.stubEnv('ICD_TEST_KEY', 'test-key')
    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { local: {
      api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'ICD_TEST_KEY',
      compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
      models: [{ id: 'local-model', contextWindow: 65_536, maxTokens: 4_096, reasoningEfforts: { off: null, high: 'high' }, input: ['text', 'image'] }],
    } } })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('local')
    expect((await ctx.llm.listModels('local')).map(model => model.id)).toContain('local-model')
    const info = await ctx.llm.resolveModelInfo('local', 'local-model')
    expect(info).toMatchObject({ id: 'local-model', context: { contextWindow: 65_536 }, defaultMaxTokens: 4_096 })
    expect(info.inputModalities).toEqual(expect.arrayContaining(['text', 'image']))
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(expect.arrayContaining(['high']))
    vi.unstubAllEnvs()
  })

  it('LLM-3 a plugin streams its own request and assembles the blocks, usage and finish kind', async () => {
    const run = await host(new ScriptedModel([text('own summary')]))
    ctx = run.ctx
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({ ...MODEL, messages: [createUserMessage({ content: [{ type: 'text', text: 'sum up' }],
      source: { kind: 'user' } })] })) assembler.push(chunk)
    expect(assembler.finish.kind).toBe('stop')
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'own summary' }])
    expect(assembler.usage?.inputTokens).toBe(10)
  })
})
