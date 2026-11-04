/** TL: system prompt sections and contexts, tool sets, guards, tool hooks and argument violations (README.md, TL). */
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { validateArgs } from '@deepseek-ai/dsh-tools'
import { Config as TodoConfig } from '@deepseek-ai/dsh-tool-todo'
import { Config as WebToolConfig } from '@deepseek-ai/dsh-tool-web'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { host, open, person, ScriptedModel, text, textTool, toolCall } from './harness.ts'

let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

const sent = (options: GenerateOptions): string => JSON.stringify({ system: options.system, messages: options.messages })
const toolNames = (options: GenerateOptions): string[] => (options.tools ?? []).map(tool => tool.name)
type Logged = { session: { snapshotEvents(): readonly { type: string; data: unknown }[] } }
const toolResults = (agent: Logged): string[] => agent.session.snapshotEvents()
  .filter(event => event.type === 'tool/result')
  .map(event => JSON.stringify(event.data))

describe('TL. Prompt and tools', () => {
  it('TL-1 a scope blanks a global section by its name, adds its own, suppresses runtime context and shadows the working directory', async () => {
    const run = await host(new ScriptedModel([text('scoped'), text('plain')]))
    ctx = run.ctx
    const prompt = ctx.systemPrompt
    for (const [name, order] of [['harness:source', 'HARNESS_SOURCE'], ['ui:deliverable-file-references', 'DELIVERABLE_FILE_REFERENCES'],
      ['app:web-surface', 'WEB_SURFACE'], ['tool:web_search', 'TOOL_WEB_SEARCH']] as const) {
      prompt.section({ name, order: prompt.getSectionOrder(order), text: `GLOBAL ${name}` })
    }
    prompt.context({ name: 'test:runtime', order: prompt.getContextOrder('WORKING_DIRECTORY') + 1, text: 'GLOBAL runtime snapshot' })
    prompt.context({ name: 'working-directory:current', order: prompt.getContextOrder('WORKING_DIRECTORY'), required: true,
      text: 'GLOBAL /a/real/local/path' })

    const scoped = await open(ctx, 'tl-1-scoped', (scope) => {
      const p = scope.systemPrompt
      for (const [name, order] of [['harness:identity', 'HARNESS_IDENTITY'], ['harness:source', 'HARNESS_SOURCE'],
        ['ui:deliverable-file-references', 'DELIVERABLE_FILE_REFERENCES'], ['app:web-surface', 'WEB_SURFACE'],
        ['tool:web_search', 'TOOL_WEB_SEARCH']] as const) {
        p.section({ name, order: p.getSectionOrder(order), text: '' })
      }
      p.section({ name: PERSONA_PREFIX_SECTION, order: p.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), interpolate: false,
        text: () => 'SCOPED persona' })
      p.suppressRuntimeContext()
      p.context({ name: 'working-directory:current', order: p.getContextOrder('WORKING_DIRECTORY'), required: true, text: '' })
    })
    const plain = await open(ctx, 'tl-1-plain')
    scoped.followup(person('go'))
    await scoped.whenIdle()
    plain.followup(person('go'))
    await plain.whenIdle()

    const [inScope, outside] = run.model.requests.map(sent)
    expect(inScope).toContain('SCOPED persona')
    expect(inScope).not.toContain('GLOBAL')
    expect(inScope).not.toContain('powered by DeepSeek Harness')
    expect(outside).toContain('GLOBAL harness:source')
    expect(outside).toContain('powered by DeepSeek Harness')
    expect(outside).toContain('GLOBAL runtime snapshot')
    expect(outside).toContain('GLOBAL /a/real/local/path')
  })

  it('TL-1 DSH still registers the sections Asuna blanks under these names', () => {
    const at = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
    expect(at('packages/core/system-prompt/src/index.ts')).toContain("'harness:identity'")
    expect(at('packages/context/harness-dev-context/src/index.ts')).toContain("'harness:source'")
    expect(at('packages/context/harness-dev-context/src/index.ts')).toContain("'app:web-surface'")
    expect(at('packages/client/ui-deliverables/src/index.ts')).toContain("'ui:deliverable-file-references'")
    expect(at('packages/web/tool-web/src/search.ts')).toContain("'tool:web_search'")
    expect(at('packages/session/working-directory/src/index.ts')).toContain("'working-directory:current'")
  })

  it('TL-2 a scope empties its inherited tools and registers its own; a guard refuses in its own words before validation; a tool can end the turn', async () => {
    const run = await host(new ScriptedModel([
      toolCall('c1', 'own', {}),
      toolCall('c2', 'strict', {}),
      toolCall('c3', 'conclude', {}),
      text('never asked'),
    ]))
    ctx = run.ctx
    ctx.tools.register(textTool('inherited', () => 'inherited ran'))
    let concluded = false
    const agent = await open(ctx, 'tl-2', (scope) => {
      scope.tools.restrict({ allow: [] })
      scope.tools.register(textTool('own', () => 'own ran'))
      scope.tools.register(textTool('strict', () => 'strict ran', { parameters: { needed: { type: 'string', required: true } } }))
      scope.tools.register(textTool('conclude', (_args, exec) => { concluded = true; exec.concludeTurn(); return 'concluded' }))
      scope.tools.guard(exec => (exec.name === 'strict' ? '按我的话拒绝' : undefined))
    })
    agent.followup(person('go'))
    await agent.whenIdle()

    expect(toolNames(run.model.requests[0]!)).not.toContain('inherited')
    expect(toolNames(run.model.requests[0]!)).toEqual(expect.arrayContaining(['own', 'strict', 'conclude']))
    const results = toolResults(agent)
    expect(results[0]).toContain('own ran')
    expect(results[1]).toContain('按我的话拒绝')
    expect(results[1]).not.toContain('missing required property')
    expect(concluded).toBe(true)
    expect(run.model.requests).toHaveLength(3)
  })

  it('TL-3 pre-execute refuses a call with its error; tools/execute wraps the body so its async context reaches the body', async () => {
    const run = await host(new ScriptedModel([toolCall('c1', 'fenced', {}), toolCall('c2', 'scoped', {}), text('done')]))
    ctx = run.ctx
    const store = new AsyncLocalStorage<string>()
    let fencedRan = false
    let seen: string | undefined
    const agent = await open(ctx, 'tl-3', (scope) => {
      scope.tools.register(textTool('fenced', () => { fencedRan = true; return 'ran' }))
      scope.tools.register(textTool('scoped', () => { seen = store.getStore(); return 'ok' }))
      scope.on('tools/pre-execute', async (exec, next) => {
        if (exec.name === 'fenced') throw new Error('STAGE_SUPPRESSED: not run')
        return next()
      })
      scope.on('tools/execute', (exec, next) => store.run(`network for ${exec.name}`, next))
    })
    agent.followup(person('go'))
    await agent.whenIdle()
    expect(fencedRan).toBe(false)
    expect(toolResults(agent)[0]).toContain('STAGE_SUPPRESSED: not run')
    expect(seen).toBe('network for scoped')
  })

  it('TL-4 an argument violation names the argument and why, in the wording Asuna reads', () => {
    const spec = {
      op: { type: 'string', required: true, enum: ['add', 'drop'] },
      count: { type: 'integer' },
      label: { type: 'string' },
    } as const
    const missing = validateArgs(spec, {})
    expect(missing).toContainEqual(expect.stringMatching(/^missing required property "op"$/))
    const notOne = validateArgs(spec, { op: 'keep' })
    expect(notOne).toContainEqual(expect.stringMatching(/^"op" must be one of \[.*\]$/))
    expect(JSON.parse(/must be one of (\[.*\])$/.exec(notOne.find(v => v.includes('one of'))!)![1]!)).toEqual(['add', 'drop'])
    const wrongType = validateArgs(spec, { op: 'add', count: 'x', label: 3 })
    expect(wrongType).toContainEqual(expect.stringMatching(/^"count" must be an? .+$/))
    expect(wrongType).toContainEqual('"label" must be a string')
  })
})

describe('TL. Built-in tools Asuna configures', () => {
  it('TL-5 the todo and web tools take the settings Asuna gives them', () => {
    expect(TodoConfig({ allowParallelInProgress: false })).toMatchObject({ allowParallelInProgress: false })
    expect(WebToolConfig({ search: false, fetch: true })).toMatchObject({ search: false, fetch: true })
  })
})
