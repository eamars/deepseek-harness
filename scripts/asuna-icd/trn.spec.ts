/** TRN: an agent's inbox and the order of a turn's hooks (README.md, TRN). */
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { host, idle, open, person, ScriptedModel, text, textTool, toolCall, wordsOf } from './harness.ts'

let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe('TRN. Inbox and turns', () => {
  it('TRN-1 a follow-up starts a turn when idle; an injected message never wakes an idle agent; a steer goes to the next step; a splice persists', async () => {
    const run = await host(new ScriptedModel([text('first'), text('second')]))
    ctx = run.ctx
    const agent = await open(ctx, 'trn-1')

    agent.inject(person('injected while idle'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(agent.status).toBe('idle')
    expect(run.model.requests).toHaveLength(0)
    expect(agent.inbox.nextStep.map(m => m.id)).toHaveLength(1)

    agent.followup(person('follow-up'))
    await agent.whenIdle()
    expect(run.model.requests).toHaveLength(1)
    expect(wordsOf(run.model.requests[0]!)).toContain('injected while idle')
    expect(wordsOf(run.model.requests[0]!)).toContain('follow-up')

    const queued = person('queued for the next turn')
    agent.inbox.append('next-turn', queued)
    expect(agent.inbox.nextTurn.map(m => m.id)).toContain(queued.id)
    agent.inbox.remove(queued.id)
    expect(agent.inbox.nextTurn.map(m => m.id)).not.toContain(queued.id)
    const spliced = agent.session.snapshotEvents().filter(e => e.type === 'agent/inbox/spliced')
    expect(spliced.length).toBeGreaterThan(0)

    let steeredTarget: string | undefined
    ctx.on('agent/inbox/inserted', ({ agent: subject, message }) => {
      if (subject === agent && message.content.some(b => b.type === 'text' && b.text === 'steer')) {
        steeredTarget = subject.inbox.nextStep.some(m => m.id === message.id) ? 'next-step' : 'other'
      }
    })
    agent.steer(person('steer'))
    await agent.whenIdle()
    expect(steeredTarget).toBe('next-step')
  })

  it('TRN-2 an agent is running from the claim of a turn input to the turn end, idle otherwise, and told idle at every turn end', async () => {
    const run = await host(new ScriptedModel([text('a'), text('b')]))
    ctx = run.ctx
    const agent = await open(ctx, 'trn-2')
    const statuses: string[] = []
    const seenInRequest: string[] = []
    ctx.on('agent/status', ({ agent: subject, status }) => { if (subject === agent) statuses.push(status) })
    ctx.on('agent/request', async ({ agent: subject }, next) => {
      seenInRequest.push(subject.status)
      return next()
    })
    expect(agent.status).toBe('idle')
    agent.followup(person('one'))
    await idle(ctx, agent)
    agent.followup(person('two'))
    await agent.whenIdle()
    expect(seenInRequest).toEqual(['running', 'running'])
    expect(statuses).toEqual(['running', 'idle', 'running', 'idle'])
    expect(agent.status).toBe('idle')
  })

  it('TRN-3 an inserted message is heard while the agent runs, in time to move it to the next turn before it is claimed', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = await host(new ScriptedModel([toolCall('c1', 'wait', {}), text('stage done'), text('next turn')]))
    ctx = run.ctx
    ctx.tools.register(textTool('wait', async () => { await gate; return 'waited' }))
    const agent = await open(ctx, 'trn-3')
    ctx.on('agent/inbox/inserted', ({ agent: subject, message }) => {
      if (subject !== agent || subject.status !== 'running') return
      queueMicrotask(() => {
        if (!subject.inbox.nextStep.some(m => m.id === message.id)) return
        subject.inbox.remove(message.id)
        subject.inbox.append('next-turn', message)
      })
    })
    agent.followup(person('start'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(agent.status).toBe('running')
    agent.steer(person('steered mid-stage'))
    await new Promise(resolve => setTimeout(resolve, 0))
    release()
    await idle(ctx, agent)
    await agent.whenIdle()
    expect(run.model.requests).toHaveLength(3)
    expect(wordsOf(run.model.requests[1]!)).not.toContain('steered mid-stage')
    expect(wordsOf(run.model.requests[2]!)).toContain('steered mid-stage')
  })

  it('TRN-4 claim, assembly, pre-step, request, stream, step end, turn-stopping, idle run in that order; a steer in turn-stopping continues the turn', async () => {
    const run = await host(new ScriptedModel([text('first'), text('second')]))
    ctx = run.ctx
    const agent = await open(ctx, 'trn-4')
    const order: string[] = []
    let steered = false
    ctx.on('agent/inbox/claimed', ({ agent: subject }) => { if (subject === agent) order.push('claimed') })
    ctx.on('system-prompt/assemble', async (_assembly, { agent: subject }, next) => {
      if (subject === agent) {
        order.push('assemble')
        await new Promise(resolve => setTimeout(resolve, 30))
      }
      return next()
    })
    ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
      if (subject === agent) order.push('pre-step')
      return next()
    })
    ctx.on('agent/request', async ({ agent: subject }, next) => {
      if (subject === agent) order.push('request')
      return { ...await next(), maxTokens: 123 }
    })
    ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject === agent && frame.type === 'chunk' && frame.chunk.type === 'finish') order.push(`finish:${frame.chunk.reason.kind}`)
    })
    ctx.on('session/event', (session, event) => {
      if (session.id === agent.session.id && event.type === 'step/end') order.push('step-end')
    })
    ctx.on('agent/turn-stopping', async ({ agent: subject }) => {
      if (subject !== agent) return
      order.push('turn-stopping')
      if (!steered) {
        steered = true
        subject.steer(person('one more'))
      }
    })
    ctx.on('agent/status', ({ agent: subject, status }) => { if (subject === agent && status === 'idle') order.push('idle') })
    agent.followup(person('go'))
    await idle(ctx, agent)

    expect(order.slice(0, 8)).toEqual(['claimed', 'assemble', 'pre-step', 'request', 'finish:stop', 'step-end', 'turn-stopping', 'claimed'])
    expect(order.filter(o => o === 'idle')).toEqual(['idle'])
    expect(order.at(-1)).toBe('idle')
    expect(run.model.requests.map(r => r.maxTokens)).toEqual([123, 123])
    expect(agent.session.snapshotEvents().filter(e => e.type === 'turn/start')).toHaveLength(1)
  })

  it('TRN-4 a pre-step reject ends the step with no model request', async () => {
    const run = await host(new ScriptedModel([text('unused')]))
    ctx = run.ctx
    const agent = await open(ctx, 'trn-4-reject')
    ctx.on('agent/pre-step', async ({ agent: subject }, next) => (subject === agent ? { kind: 'reject' } : next()))
    agent.followup(person('go'))
    await agent.whenIdle()
    expect(run.model.requests).toHaveLength(0)
  })

  it('TRN-5 a failed request can be retried by a plugin that also gets DSH\'s own decision; a cancel can keep the queued input', async () => {
    const run = await host(new ScriptedModel([
      () => { throw new LlmError('busy', 'RATE_LIMIT') },
      text('ok'),
    ]))
    ctx = run.ctx
    const agent = await open(ctx, 'trn-5')
    const codes: string[] = []
    ctx.on('agent/request-error', async ({ agent: subject, failure }, next) => {
      if (subject !== agent) return next()
      codes.push(failure.code)
      await next()
      return { kind: 'retry' }
    })
    agent.followup(person('go'))
    await agent.whenIdle()
    expect(codes).toEqual(['RATE_LIMIT'])
    expect(run.model.requests).toHaveLength(2)

    agent.inbox.append('next-turn', person('kept'))
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    await agent.whenIdle()
    expect(agent.inbox.nextTurn.length + agent.inbox.nextStep.length).toBeGreaterThan(0)
  })

  it('TRN-5 a failed turn carries its cause chain to agent/error', async () => {
    const run = await host(new ScriptedModel([() => { throw new LlmError('too long', 'CONTEXT_WINDOW_EXCEEDED') }]))
    ctx = run.ctx
    const agent = await open(ctx, 'trn-5-error')
    const seen: unknown[] = []
    ctx.on('agent/error', ({ agent: subject, error }) => { if (subject === agent) seen.push(error) })
    agent.followup(person('go'))
    await agent.whenIdle()
    const chain = (error: unknown): string[] => {
      const codes: string[] = []
      type Link = { code?: string; cause?: unknown } | undefined
      for (let at = error as Link; at; at = at.cause as Link) if (at.code) codes.push(at.code)
      return codes
    }
    expect(seen.flatMap(chain)).toContain('CONTEXT_WINDOW_EXCEEDED')
  })

  it('TRN-6 agent/created is heard for a new agent and finishes before its first step', async () => {
    const run = await host(new ScriptedModel([text('ok')]))
    ctx = run.ctx
    const order: string[] = []
    ctx.on('agent/created', async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      order.push('created')
    })
    ctx.on('agent/request', async (_p, next) => { order.push('request'); return next() })
    const agent = await open(ctx, 'trn-6')
    agent.followup(person('go'))
    await agent.whenIdle()
    expect(order).toEqual(['created', 'request'])
  })
})
