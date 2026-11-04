/** FW: services a plugin provides and waits for, optional services wired when they appear, and the log exporter (README.md, FW). */
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'

let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe('FW. Plugin framework', () => {
  it('FW-1 a provided service is injected into a plugin that waits for it; an optional one is wired when it appears and unwired when it goes', async () => {
    ctx = new Context()
    const order: string[] = []
    const root = ctx
    await root.plugin({
      name: 'icd-core',
      inject: ['icdCore'],
      apply: (scope: Context) => { order.push(`core sees ${(scope as unknown as { icdCore: { id: string } }).icdCore.id}`) },
    })
    expect(order).toEqual([])
    root.provide('icdCore', { id: 'provided' })
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(order).toEqual(['core sees provided'])

    let wired = 0
    let unwired = 0
    root.inject(['icdOptional'], (scope) => {
      wired += 1
      scope.effect(() => () => { unwired += 1 })
    })
    expect(wired).toBe(0)
    class Optional extends Service { constructor(scope: Context) { super(scope, 'icdOptional') } }
    const fiber = await root.plugin(Optional)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(wired).toBe(1)
    await fiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(unwired).toBe(1)

    let absent: unknown
    try { absent = root.get('icdNeverProvided') } catch { absent = undefined }
    expect(absent).toBeUndefined()
  })

  it('FW-3 an exporter receives every plugin\'s log messages with name, level, arguments and time', async () => {
    ctx = new Context()
    type Message = { name?: string; type?: string; args: unknown[]; ts?: number }
    const seen: Message[] = []
    ctx.logger.exporter({ colors: 0, levels: { default: 2 }, export: (message: Message) => { seen.push(message) } })
    await ctx.plugin({ name: 'icd-other', apply: (scope: Context) => { scope.logger.warn('from another plugin %s', 'x') } })
    const line = seen.find(message => JSON.stringify(message.args).includes('from another plugin'))
    expect(line).toBeDefined()
    expect(line).toMatchObject({ type: 'warn', name: expect.any(String) as string, ts: expect.any(Number) as number })
  })
})
