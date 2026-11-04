/** SCH: plans bound to a session, retimed in place, and fired into that session's inbox (README.md, SCH). */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { agentFor, harness } from '../../packages/schedule/schedule/tests/harness.ts'

const contexts: Context[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-16T00:00:00.000Z'))
})
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.useRealTimers()
})

async function schedule() {
  const test = await harness({ onContext: ctx => contexts.push(ctx) })
  return test
}

const PROMPT = 'ASUNA_PLAN:plan-1\n"quoted" words'

/** How Asuna reads a fired plan (cognition-core schedule.js): `key: value` lines naming the plan and the occurrence. */
function firedPlans(message: UserMessage): { schedule_id: string; occurrence_at?: string | undefined }[] {
  const text = message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
  const fields = Object.fromEntries(text.split('\n').flatMap((line) => {
    const at = line.indexOf(': ')
    return at < 0 ? [] : [[line.slice(0, at), line.slice(at + 2)]]
  })) as Record<string, string | undefined>
  if (fields['reminders_json'] !== undefined) return JSON.parse(fields['reminders_json']) as { schedule_id: string }[]
  if (fields['schedule_id_json'] !== undefined) {
    return [{ schedule_id: JSON.parse(fields['schedule_id_json']) as string, occurrence_at: fields['occurrence_at'] }]
  }
  return []
}

/** A plan delivered into one existing session, made by that session so DSH writes it no change notice. */
function forSession(sessionId: SessionId) {
  return { target: { kind: 'session' as const, sessionId } }
}

async function plansOf(service: Context['schedule'], sessionId: SessionId) {
  const page = await service.list({ limit: 100 })
  return page.items.filter(row => row.target.kind === 'session' && row.target.sessionId === sessionId)
}

/**
 * A plugin creates, retimes and deletes a plan of a live session. With `asOwner`, each call names that session as the
 * actor (0.2.2 sends a `[SCHEDULE CHANGE]` notice to every involved live session except the actor).
 */
export async function ownChanges(asOwner: boolean) {
  const { ctx, service, resolve } = await schedule()
  const agent = agentFor(ctx, 'sch-5')
  resolve.mockResolvedValue({ agent } as never)
  // The session is live while the plugin changes its plans, as Asuna's sessions are.
  const live = ctx.agents.get.bind(ctx.agents)
  vi.spyOn(ctx.agents, 'get').mockImplementation(id => (id === agent.session.id ? agent as never : live(id)))
  const steer = vi.spyOn(agent, 'steer')
  const actor = asOwner ? agent.session.id : undefined
  const plan = await service.create({
    title: 'rhythm', prompt: PROMPT, timing: { kind: 'every', every_seconds: 3_600 }, ...forSession(agent.session.id),
  }, actor)
  const read = await service.view({ id: plan.id })
  await vi.advanceTimersByTimeAsync(1_000)
  await service.edit({
    id: plan.id, action: 'update', patch: { timing: { kind: 'every', every_seconds: 1_800 } },
    expectedUpdatedAt: 'code' in read ? null : read.updatedAt ?? null,
  }, actor)
  await service.edit({ id: plan.id, action: 'delete' }, actor)
  await vi.advanceTimersByTimeAsync(10)
  return {
    session: agent.session,
    injected: () => agent.inject.mock.calls.map(([message]) => message),
    calls: () => ({ inject: agent.inject.mock.calls.length, steer: steer.mock.calls.length, followup: agent.followup.mock.calls.length }),
  }
}

describe('SCH. Schedule', () => {
  it('SCH-1 one-shot and recurring plans are created for a session, and the prompt round-trips verbatim', async () => {
    const { service } = await schedule()
    const sessionId = SessionId('sch-1')
    const make = (title: string, timing: Parameters<typeof service.create>[0]['timing']) =>
      service.create({ title, prompt: PROMPT, timing, ...forSession(sessionId) }, sessionId)
    const once = await make('once', { kind: 'after', after_seconds: 600 })
    const every = await make('every', { kind: 'every', every_seconds: 3_600 })
    const daily = await make('daily', { kind: 'daily', daily: { time: '08:30:00', time_zone: 'Europe/Paris' } })
    const weekly = await make('weekly', { kind: 'weekly', weekly: { time: '21:00:00', time_zone: 'Europe/Paris', weekdays: [1, 3, 7] } })
    const rows = await plansOf(service, sessionId)
    expect(rows.map(row => row.id).sort()).toEqual([once.id, every.id, daily.id, weekly.id].sort())
    expect(new Set(rows.map(row => row.kind))).toEqual(new Set(['after', 'every', 'daily', 'weekly']))
    for (const row of rows) {
      expect(row.prompt).toBe(PROMPT)
      expect(typeof row.scheduledAt).toBe('string')
    }
  })

  it('SCH-2 a plan is retimed in place under an optimistic check, listed with its next fire time, and deleted', async () => {
    const { service } = await schedule()
    const sessionId = SessionId('sch-2')
    const plan = await service.create({ title: 'rhythm', prompt: PROMPT, timing: { kind: 'every', every_seconds: 3_600 }, ...forSession(sessionId) }, sessionId)
    const read = async () => {
      const row = await service.view({ id: plan.id })
      if ('code' in row) throw new Error(`plan ${plan.id}: ${row.code}`)
      return row
    }
    const expected = await read()
    // Each edit happens at a later instant, so the revision it stamps differs from the one it was checked against.
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await service.edit({
      id: plan.id, action: 'update', patch: { timing: { kind: 'every', every_seconds: 900 } }, expectedUpdatedAt: expected.updatedAt ?? null,
    }, sessionId)
    expect(result).toMatchObject({ id: plan.id, kind: 'every', everySeconds: 900 })
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(service.edit({
      id: plan.id, action: 'update', patch: { timing: { kind: 'every', every_seconds: 60 } }, expectedUpdatedAt: expected.updatedAt ?? null,
    }, sessionId)).resolves.toMatchObject({ id: plan.id, code: 'schedule_conflict' })

    const current = await read()
    await service.edit({
      id: plan.id, action: 'update', patch: { timing: { kind: 'daily', daily: { time: '07:00:00', time_zone: 'Europe/Paris' } } },
      expectedUpdatedAt: current.updatedAt ?? null,
    }, sessionId)
    expect(await read()).toMatchObject({ id: plan.id, kind: 'daily', time: expect.stringMatching(/^07:00:00/) as string })

    const catalog = await service.catalog()
    expect(catalog.find(row => row.id === plan.id)).toMatchObject({ target: { kind: 'session', sessionId }, scheduledAt: expect.any(String) as string })
    expect(await service.edit({ id: plan.id, action: 'delete' }, sessionId)).toEqual({ id: plan.id, deleted: true })
    expect(await plansOf(service, sessionId)).toEqual([])
  })

  it('SCH-3 a plan fires into its own session as a schedule message naming the plan and the occurrence', async () => {
    const { ctx, service, resolve } = await schedule()
    const agent = agentFor(ctx, 'sch-3')
    resolve.mockResolvedValue({ agent } as never)
    const plan = await service.create({
      title: 'soon', prompt: PROMPT, timing: { kind: 'after', after_seconds: 1 }, ...forSession(agent.session.id),
    }, agent.session.id)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(agent.followup).toHaveBeenCalled()
    const message = agent.followup.mock.calls[0]![0]
    expect(message.source).toMatchObject({ kind: 'schedule' })
    expect(firedPlans(message).map(fired => fired.schedule_id)).toContain(plan.id)
    const finished = (await service.catalog()).find(row => row.id === plan.id)
    expect(finished?.status).toBe('ended')
  })

  it('SCH-5 a plugin\'s own create, retime and delete put nothing into the session', async () => {
    const { session, calls } = await ownChanges(true)
    expect(calls()).toEqual({ inject: 0, steer: 0, followup: 0 })
    expect(session.snapshotEvents()).toEqual([])
  })
})

describe('SCH. The Web Host provides it', () => {
  it('SCH-4 the Web bundle mounts the schedule service', () => {
    const bundle = readFileSync(new URL('../../packages/bundle/web-app/cordis.patch.yml', import.meta.url), 'utf8')
    expect(bundle).toMatch(/id: schedule\s+name: '@deepseek-ai\/dsh-schedule'/)
  })
})
