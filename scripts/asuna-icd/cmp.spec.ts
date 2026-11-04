/** CMP: a plugin's own compaction summary, applied atomically, and compaction that keeps a whole last turn (README.md, CMP). */
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as CommandCompact from '@deepseek-ai/dsh-command-compact'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { host, open, person, ScriptedModel, text } from './harness.ts'

let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

type Summarize = BasicCompactionEngine['summarize']
const sent = (options: GenerateOptions): string => JSON.stringify(options.messages)
const OLD = 'older words '.repeat(80)

/** The engine with its summary replaced, as Asuna's RoleCompactionEngine replaces it. */
function engine(target: Context, summarize: (...args: Parameters<Summarize>) => ReturnType<Summarize>): BasicCompactionEngine {
  class Own extends BasicCompactionEngine {
    override summarize(...args: Parameters<Summarize>): ReturnType<Summarize> { return summarize(...args) }
  }
  return new Own(target, { auto: false })
}

/** Three closed turns; the last one has its own words. */
async function threeTurns(target: Context): Promise<Agent> {
  const agent = await open(target, 'cmp')
  for (const words of [`turn one ${OLD}`, `turn two ${OLD}`, 'turn three, kept word for word']) {
    agent.followup(person(words))
    await agent.whenIdle()
  }
  return agent
}

const userSeqs = (agent: Agent) => agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.seq)

describe('CMP. Compaction', () => {
  it('CMP-3 compaction now keeps everything from a chosen sequence number verbatim and replaces what came before', async () => {
    const run = await host(new ScriptedModel([text('one'), text('two'), text('three'), text('after')], { context: { contextWindow: 100_000 } }))
    ctx = run.ctx
    await ctx.plugin(TokenMeter)
    const compaction = engine(ctx, () => Promise.resolve({ summary: [{ type: 'text', text: 'OWN CHECKPOINT' }], provider: 'scripted', model: 'scripted' }))
    expect(compaction.compactNow.length).toBeGreaterThanOrEqual(4)
    const agent = await threeTurns(ctx)
    const keepFrom = userSeqs(agent)[2]!

    const result = await compaction.compactNow(agent, new AbortController().signal, undefined, { keepFrom })
    expect(result).toMatchObject({ compactionId: expect.any(String) as string, shadowedSeqs: expect.any(Array) as unknown[] })
    expect(result!.shadowedSeqs).not.toContain(keepFrom)

    agent.followup(person('next'))
    await agent.whenIdle()
    const next = sent(run.model.requests.at(-1)!)
    expect(next).toContain('OWN CHECKPOINT')
    expect(next).toContain('turn three, kept word for word')
    expect(next).toContain('three')
    expect(next).not.toContain('turn one')
  })

  it('CMP-2 a summary that throws leaves the conversation exactly as it was', async () => {
    const run = await host(new ScriptedModel([text('one'), text('two'), text('three'), text('after')], { context: { contextWindow: 100_000 } }))
    ctx = run.ctx
    await ctx.plugin(TokenMeter)
    const compaction = engine(ctx, () => Promise.reject(new Error('summary failed')))
    const agent = await threeTurns(ctx)
    const before = [...agent.session.surface.nodes]

    await expect(compaction.compactNow(agent, new AbortController().signal, undefined, { keepFrom: userSeqs(agent)[2]! })).rejects.toThrow()
    expect([...agent.session.surface.nodes]).toEqual(before)

    agent.followup(person('next'))
    await agent.whenIdle()
    expect(sent(run.model.requests.at(-1)!)).toContain('turn one')
  })

  it('CMP-1 the engine takes the thresholds Asuna configures, and the token meter a plugin reads measures a session', async () => {
    const run = await host(new ScriptedModel([text('one')], { context: { contextWindow: 100_000 } }))
    ctx = run.ctx
    await ctx.plugin(TokenMeter)
    expect(() => new BasicCompactionEngine(ctx!, {
      auto: false, thresholdRatio: 0.8, headroomTokens: 8_000, maxTokens: 4_000, retainRatio: 0.2,
      modelPolicies: [{ provider: 'scripted', model: 'scripted', thresholdRatio: 0.7, headroomTokens: 4_000 }],
    })).not.toThrow()
    const agent = await open(ctx, 'cmp-1')
    agent.followup(person('measure me'))
    await agent.whenIdle()
    expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeGreaterThan(0)
  })
})

describe('TL. Commands', () => {
  it('TL-6 a plugin registers its own command, and /compact on an agent says how many history items it compacted', async () => {
    const run = await host(new ScriptedModel([text('one'), text('two'), text('three')], { context: { contextWindow: 100_000 } }))
    ctx = run.ctx
    await ctx.plugin(TokenMeter)
    await ctx.plugin(CommandRuntime)
    class Own extends BasicCompactionEngine {
      override summarize(): ReturnType<Summarize> {
        return Promise.resolve({ summary: [{ type: 'text', text: 'OWN CHECKPOINT' }], provider: 'scripted', model: 'scripted' })
      }
    }
    await ctx.plugin(Own, { auto: false })
    await ctx.plugin(CommandCompact)
    ctx.commands.register({ name: 'heartbeat', description: 'beat', handler: () => Promise.resolve({ kind: 'success', text: 'beat' }) })
    const agent = await threeTurns(ctx)
    const signal = new AbortController().signal

    const beat = await ctx.commands.execute(agent, '/heartbeat', [], signal)
    expect(beat?.result).toMatchObject({ kind: 'success', text: 'beat' })
    const done = await ctx.commands.execute(agent, '/compact', [], signal)
    expect(done?.result.kind).toBe('success')
    const counted = /Compacted (\d+) history items \(~(\d+) tokens\)/.exec(done?.result.text ?? '')
    expect(counted).not.toBeNull()
    expect(Number(counted![1])).toBeGreaterThan(0)
  })
})

describe('CMP. Overflow', () => {
  it('CMP-5 a request that overflows the window is compacted once and, failing again, ends the turn with the overflow code', async () => {
    const overflow = () => { throw new LlmError('too long', 'CONTEXT_WINDOW_EXCEEDED') }
    const run = await host(new ScriptedModel([text('one'), text('two'), text('three'), overflow, overflow, overflow],
      { context: { contextWindow: 100_000 } }))
    ctx = run.ctx
    await ctx.plugin(TokenMeter)
    let summaries = 0
    class Own extends BasicCompactionEngine {
      override summarize(): ReturnType<Summarize> {
        summaries += 1
        return Promise.resolve({ summary: [{ type: 'text', text: 'OWN CHECKPOINT' }], provider: 'scripted', model: 'scripted' })
      }
    }
    await ctx.plugin(Own, { auto: true })
    const agent = await threeTurns(ctx)
    const codes: string[] = []
    ctx.on('agent/error', ({ agent: subject, error }) => {
      type Link = { code?: string; cause?: unknown } | undefined
      if (subject === agent) for (let at = error as Link; at; at = at.cause as Link) if (at.code) codes.push(at.code)
    })
    agent.followup(person('one more'))
    await agent.whenIdle()
    expect(summaries).toBe(1)
    expect(codes).toContain('CONTEXT_WINDOW_EXCEEDED')
  })
})
