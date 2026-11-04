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

describe('SCH. Schedule', () => {
  it('SCH-1 one-shot and recurring plans are created for a session, and the prompt round-trips verbatim', async () => {
    const { service } = await schedule()
    const sessionId = SessionId('sch-1')
    const once = await service.create(sessionId, { title: 'once', prompt: PROMPT, after_seconds: 600 })
    const every = await service.create(sessionId, { title: 'every', prompt: PROMPT, every_seconds: 3_600 })
    const daily = await service.create(sessionId, { title: 'daily', prompt: PROMPT, daily: { time: '08:30:00', time_zone: 'Europe/Paris' } })
    const weekly = await service.create(sessionId, {
      title: 'weekly', prompt: PROMPT, weekly: { time: '21:00:00', time_zone: 'Europe/Paris', weekdays: [1, 3, 7] },
    })
    const rows = await service.list({ sessionId })
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
    const plan = await service.create(sessionId, { title: 'rhythm', prompt: PROMPT, every_seconds: 3_600 })
    const expected = (await service.list({ sessionId })).find(row => row.id === plan.id)!
    const result = await service.update({ sessionId, id: plan.id, expected, change: { kind: 'every', every_seconds: 900 } })
    expect(result).toMatchObject({ updated: true })
    const after = (await service.list({ sessionId })).find(row => row.id === plan.id)!
    expect(after.id).toBe(plan.id)
    expect((after as { everySeconds?: number }).everySeconds).toBe(900)
    await expect(service.update({ sessionId, id: plan.id, expected, change: { kind: 'every', every_seconds: 60 } }))
      .resolves.toMatchObject({ updated: false })

    const daily = (await service.list({ sessionId })).find(row => row.id === plan.id)!
    await service.update({ sessionId, id: plan.id, expected: daily, change: { kind: 'daily', daily: { time: '07:00:00', time_zone: 'Europe/Paris' } } })
    expect((await service.list({ sessionId })).find(row => row.id === plan.id)).toMatchObject({ kind: 'daily', time: expect.stringMatching(/^07:00:00/) as string })

    const catalog = await service.catalog()
    expect(catalog.find(row => row.id === plan.id)).toMatchObject({ sessionId, scheduledAt: expect.any(String) as string })
    await service.delete({ sessionId, id: plan.id })
    expect(await service.list({ sessionId })).toEqual([])
  })

  it('SCH-3 a plan fires into its own session as a schedule message naming the plan and the occurrence', async () => {
    const { ctx, service, resolve } = await schedule()
    const agent = agentFor(ctx, 'sch-3')
    resolve.mockResolvedValue({ agent })
    const plan = await service.create(agent.session.id, { title: 'soon', prompt: PROMPT, after_seconds: 1 })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(agent.followup).toHaveBeenCalled()
    const message = agent.followup.mock.calls[0]![0]
    expect(message.source).toMatchObject({ kind: 'schedule' })
    expect(firedPlans(message).map(fired => fired.schedule_id)).toContain(plan.id)
    // A firing is told from any other schedule-sourced message (0.2.2's change notice) by its first line.
    const first = message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n').split('\n')[0]
    expect(first).toMatch(/^\[SCHEDULE REMINDER/)
    const finished = (await service.catalog()).find(row => row.id === plan.id) as { status?: string } | undefined
    expect(finished?.status).toBe('inactive')
  })

  it('SCH-5 a plugin\'s own create, retime and delete put nothing into the session', async () => {
    const { ctx, service, resolve } = await schedule()
    const agent = agentFor(ctx, 'sch-5')
    const inject = vi.spyOn(agent, 'inject')
    const steer = vi.spyOn(agent, 'steer')
    resolve.mockResolvedValue({ agent })
    const plan = await service.create(agent.session.id, { title: 'rhythm', prompt: PROMPT, every_seconds: 3_600 })
    const expected = (await service.list({ sessionId: agent.session.id })).find(row => row.id === plan.id)!
    await service.update({ sessionId: agent.session.id, id: plan.id, expected, change: { kind: 'every', every_seconds: 1_800 } })
    await service.delete({ sessionId: agent.session.id, id: plan.id })
    await vi.advanceTimersByTimeAsync(10)
    expect(inject).not.toHaveBeenCalled()
    expect(steer).not.toHaveBeenCalled()
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.session.snapshotEvents()).toEqual([])
  })
})

describe('SCH. The Web Host provides it', () => {
  it('SCH-4 the Web bundle mounts the schedule service', () => {
    const bundle = readFileSync(new URL('../../packages/bundle/web-app/cordis.patch.yml', import.meta.url), 'utf8')
    expect(bundle).toMatch(/id: schedule\s+name: '@deepseek-ai\/dsh-schedule'/)
  })
})
