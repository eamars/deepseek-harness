/** SES: sessions opened on chosen ids, cold access to their logs, plugin records and the event vocabulary (README.md, SES). */
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { host, MODEL, open, person, scratch, ScriptedModel, text, textTool, toolCall } from './harness.ts'

let ctx: Context | undefined
let folder: { root: string; remove: () => void } | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  folder?.remove()
  ctx = undefined
  folder = undefined
})

const sent = (options: GenerateOptions): string => JSON.stringify({ system: options.system, messages: options.messages })

async function persisted(model: ScriptedModel) {
  folder = scratch()
  const run = await host(model, { root: folder.root })
  ctx = run.ctx
  return run
}

describe('SES. Sessions', () => {
  it('SES-1 an agent opens on the id the caller chooses, with its options and a setup before the first step; it resumes with new options', async () => {
    const run = await persisted(new ScriptedModel([text('first'), text('second')]))
    const order: string[] = []
    const handle = await run.ctx.agents.create({
      sessionId: SessionId('ses-1-chosen'),
      agentOptions: { ...MODEL, maxTokens: 111 },
      setup: () => { order.push('setup') },
    })
    run.ctx.on('agent/request', async (_p, next) => { order.push('request'); return next() })
    expect(handle.agent.session.id).toBe('ses-1-chosen')
    expect(run.ctx.agents.get(SessionId('ses-1-chosen'))).toBe(handle.agent)
    handle.agent.followup(person('one'))
    await handle.agent.whenIdle()
    expect(order).toEqual(['setup', 'request'])
    expect(run.model.requests[0]!.maxTokens).toBe(111)
    await handle.dispose()
    expect(run.ctx.agents.get(SessionId('ses-1-chosen'))).toBeUndefined()

    const resumed = await run.ctx.agents.resume({ resumeSessionId: SessionId('ses-1-chosen'), agentOptions: { ...MODEL, maxTokens: 222 } })
    resumed.agent.followup(person('two'))
    await resumed.agent.whenIdle()
    expect(run.model.requests[1]!.maxTokens).toBe(222)
    expect(sent(run.model.requests[1]!)).toContain('one')
  })

  it('SES-3 one writer at a time; with no agent loaded a log is read, appended with caller-assigned sequence numbers and flushed, and loads again', async () => {
    const run = await persisted(new ScriptedModel([text('hello'), text('again')]))
    const handle = await run.ctx.agents.create({ sessionId: SessionId('ses-3'), agentOptions: { ...MODEL } })
    handle.agent.followup(person('first'))
    await handle.agent.whenIdle()
    await run.ctx.sessions.flush(handle.agent.session)
    await expect(run.ctx.sessionPersistence.open(SessionId('ses-3'), 'write')).rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
    await handle.dispose()

    expect((await run.ctx.sessionPersistence.stat(SessionId('ses-3')))?.header.id).toBe('ses-3')
    expect((await run.ctx.sessionPersistence.list()).map(row => row.header.id)).toContain('ses-3')
    const cold = await run.ctx.sessionPersistence.open(SessionId('ses-3'), 'write')
    try {
      const { events } = await cold.read()
      expect(events.find(event => event.surfaceOp !== undefined || (event.type as string) === 'system/message')?.type).toBe('system/message')
      await cold.append([{ type: 'user/message', data: person('written cold', { channel: 'platform', receipt: 'r-1' }),
        surfaceOp: 'append', seq: events.length, time: Date.now() } as never])
      await cold.flush()
    } finally {
      await cold.close()
    }

    const resumed = await run.ctx.agents.resume({ resumeSessionId: SessionId('ses-3'), agentOptions: { ...MODEL } })
    resumed.agent.followup(person('after'))
    await resumed.agent.whenIdle()
    expect(sent(run.model.requests[1]!)).toContain('written cold')
  })

  it('SES-3 a line written cold before the first turn waits in the inbox as a splice and joins that turn', async () => {
    const run = await persisted(new ScriptedModel([text('ok')]))
    const handle = await run.ctx.agents.create({ sessionId: SessionId('ses-3-splice'), agentOptions: { ...MODEL } })
    await run.ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
    const cold = await run.ctx.sessionPersistence.open(SessionId('ses-3-splice'), 'write')
    try {
      const { events } = await cold.read()
      expect(events.some(event => event.type === 'system/message')).toBe(false)
      await cold.append([{ type: 'agent/inbox/spliced', seq: events.length, time: Date.now(),
        data: { target: 'next-step', start: 0, inserted: [person('waited before the first turn')] } } as never])
      await cold.flush()
    } finally {
      await cold.close()
    }
    const resumed = await run.ctx.agents.resume({ resumeSessionId: SessionId('ses-3-splice'), agentOptions: { ...MODEL } })
    expect(resumed.agent.inbox.nextStep.length).toBe(1)
    resumed.agent.followup(person('go'))
    await resumed.agent.whenIdle()
    expect(sent(run.model.requests[0]!)).toContain('waited before the first turn')
  })

  it('SES-5 a plugin\'s own event, marked ignorable, persists, survives a reload under its own type and never reaches the model', async () => {
    const run = await persisted(new ScriptedModel([text('ok'), text('ok')]))
    const handle = await run.ctx.agents.create({ sessionId: SessionId('ses-5'), agentOptions: { ...MODEL } })
    handle.agent.followup(person('go'))
    await handle.agent.whenIdle()
    await run.ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
    const cold = await run.ctx.sessionPersistence.open(SessionId('ses-5'), 'write')
    try {
      const { events } = await cold.read()
      await cold.append([{ type: 'asuna/stage', data: { secret: 'PLUGIN-ONLY' }, ignorable: true, seq: events.length, time: Date.now() } as never])
      await cold.flush()
    } finally {
      await cold.close()
    }
    const resumed = await run.ctx.agents.resume({ resumeSessionId: SessionId('ses-5'), agentOptions: { ...MODEL } })
    const record = resumed.agent.session.snapshotEvents().find(event => (event.type as string) === 'asuna/stage')
    expect(record).toMatchObject({ ignorable: true, data: { secret: 'PLUGIN-ONLY' } })
    resumed.agent.followup(person('again'))
    await resumed.agent.whenIdle()
    expect(sent(run.model.requests[1]!)).not.toContain('PLUGIN-ONLY')
  })

  it('SES-6 extra source fields of a user message persist (wire.spec.ts checks they never reach the model)', async () => {
    const run = await persisted(new ScriptedModel([text('ok')]))
    const agent = await open(run.ctx, 'ses-6')
    agent.followup(person('hi', { channel: 'qq', receipt: 'RECEIPT-77', sender: 'SENDER-9', trigger: 'TRIGGER-1' }))
    await agent.whenIdle()
    const message = agent.session.snapshotEvents().find(event => event.type === 'user/message')
    expect(message?.data.source).toMatchObject({ kind: 'user', channel: 'qq', receipt: 'RECEIPT-77', sender: 'SENDER-9', trigger: 'TRIGGER-1' })
  })

  it('SES-7 a turn with a tool call writes the events Asuna reads, with the fields it reads', async () => {
    const run = await persisted(new ScriptedModel([toolCall('call-1', 'look', {}), text('done')]))
    run.ctx.tools.register(textTool('look', () => 'looked'))
    const agent = await open(run.ctx, 'ses-7')
    agent.followup(person('go'))
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    const types = events.map(event => event.type)
    for (const type of ['system/message', 'turn/start', 'step/start', 'step/end', 'tool/call', 'tool/result', 'assistant/message', 'turn/end']) {
      expect(types, type).toContain(type)
    }
    const call = events.find(event => event.type === 'tool/call')!
    const result = events.find(event => event.type === 'tool/result')!
    expect(call.data).toMatchObject({ callId: 'call-1' })
    expect(result.data.message.source).toMatchObject({ callId: 'call-1' })
    const assistant = events.find(event => event.type === 'assistant/message')!
    expect(assistant.data).toMatchObject({ turn: 1, step: expect.any(Number) as number })
    expect(assistant.data.message.content.some(block => block.type === 'tool-call')).toBe(true)
    expect(assistant.data.usage).toMatchObject({ inputTokens: expect.any(Number) as number })
  })

  it('SES-9 SES-11 a loaded session\'s context-pressure and context-breakdown projections, and its current preset, are readable', async () => {
    const run = await persisted(new ScriptedModel([text('ok')]))
    await run.ctx.plugin(TokenMeter)
    const agent = await open(run.ctx, 'ses-9')
    agent.followup(person('go'))
    await agent.whenIdle()
    const snapshot = run.ctx.sessionProjections.snapshot(agent.session, ['contextPressure', 'contextBreakdown'])
    expect(Object.keys(snapshot.values)).toEqual(expect.arrayContaining(['contextPressure', 'contextBreakdown']))
    expect(() => run.ctx.sessionProjections.stateOf(agent.session, 'agentPreset')).not.toThrow()
  })
})

describe('SES. Fork seeds', () => {
  it('SES-10 a fork seed is built from a session\'s events at a boundary and opens a new agent', async () => {
    const run = await persisted(new ScriptedModel([text('one'), text('two'), text('in the fork')]))
    const agent = await open(run.ctx, 'ses-10')
    for (const words of ['first turn', 'second turn']) {
      agent.followup(person(words))
      await agent.whenIdle()
    }
    const events = agent.session.snapshotEvents()
    const boundary = events.filter(event => event.type === 'turn/end')[0]!.seq
    const seed = buildForkSeed(events, boundary)
    expect(seed.length).toBeGreaterThan(0)
    expect(seed.slice(0, boundary + 1)).toEqual(events.slice(0, boundary + 1))
    expect(seed.some(event => event.type === 'session/end-seed')).toBe(true)
    const fork = await run.ctx.agents.create({ sessionId: SessionId('ses-10-fork'), seed, inheritedEventCount: SessionLogOffset(boundary + 1),
      meta: { parentSession: SessionId('ses-10'), isSeeded: true }, agentOptions: { ...MODEL } })
    fork.agent.followup(person('in the fork now'))
    await fork.agent.whenIdle()
    const wire = sent(run.model.requests.at(-1)!)
    expect(wire).toContain('first turn')
    expect(wire).not.toContain('second turn')
  })
})
