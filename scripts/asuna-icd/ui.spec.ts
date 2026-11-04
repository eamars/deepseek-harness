/**
 * UI: source checks. Each one checks that DSH's client sources still declare a name, key, export or prop Asuna's
 * browser entry relies on (README.md, UI), so a rename fails under its requirement's ID. They do not render
 * anything; how the page behaves is checked in a browser at the upgrade routine's review step.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Every source file of the named packages (`group/package`), joined. */
function sources(...packages: string[]): string {
  return packages.flatMap((pkg) => {
    const src = join(ROOT, 'packages', pkg, 'src')
    return existsSync(src) ? readdirSync(src, { recursive: true, encoding: 'utf8' }).map(file => join(src, file)) : []
  }).filter(file => /\.(ts|tsx)$/.test(file)).map(file => readFileSync(file, 'utf8')).join('\n')
}

const CLIENT = readdirSync(join(ROOT, 'packages', 'client')).filter(name => name.startsWith('ui-') || name === 'modules').map(name => `client/${name}`)

describe('UI. Web UI (source checks)', () => {
  it('UI-1 the client module loader and the UI primitives Asuna\'s browser entry takes are still there', () => {
    expect(sources('client/modules')).toContain('__ModuleLoader__')
    const primitives = sources('client/ui-primitives')
    for (const name of ['Button', 'Input', 'Menu', 'Pill', 'DisclosureRow', 'MarkdownText', 'SettingsForm', 'SettingsFormModel',
      'SettingsValueField', 'SettingsSecretField', 'IconChevronDownOutlineRegular']) {
      expect(primitives, name).toMatch(new RegExp(`export (?:\\{[^}]*\\b${name}\\b|(?:const|function|class) ${name}\\b)`))
    }
  })

  it('UI-2 the slots Asuna adds entries to are still named so', () => {
    const client = sources(...CLIENT)
    for (const slot of ['sidebar.right.pane.tab', 'plugins.bundle.config', 'conversation.composer.dock', 'conversation.chat.node',
      'tool.call.toolview', 'sidebar.session.row.leading', 'conversation.input.permission', 'conversation.session.header.actions']) {
      expect(client, slot).toContain(`'${slot}'`)
    }
  })

  it('UI-3 the shipped entries Asuna takes over keep their keys and words', () => {
    const chat = sources('client/ui-chat')
    expect(chat).toContain('\'turn-trigger\'')
    expect(chat).toContain('\'turn-max-tokens\'')
    expect(chat).toContain('\'message.trigger.request\'')
    expect(sources('client/ui-permission-presets')).toContain('\'permission.access\'')
  })

  it('UI-4 the fork\'s session-scoped chat content factory is declared', () => {
    const chat = sources('client/ui-chat')
    expect(chat).toContain('conversation.chat.content')
    expect(chat).toMatch(/['"]fragment['"]/)
  })

  it('UI-5 a session\'s composer can be blocked through its store, and sessions in the main view are counted', () => {
    expect(sources('client/ui-conversation')).toContain('storeFor(')
    expect(sources('api/session-controller')).toContain('retainedBy')
    expect(sources(...CLIENT)).toContain('retainedBy.mainView')
  })

  it('UI-6 DSH\'s ContextMeter component still takes useProjection and t and reads the two projections', () => {
    const meter = readFileSync(join(ROOT, 'packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx'), 'utf8')
    expect(meter).toMatch(/export function ContextMeter\(\{ useProjection, t \}/)
    expect(meter).toContain('\'contextPressure\'')
  })

  it('UI-7 UI-8 UI-9 UI-10 the event projection, right sidebar tabs, subagent resource, settings form model and locale registry are there', () => {
    const client = sources(...CLIENT)
    expect(client).toMatch(/events\s*[:=]|events\.register|register\(definition/)
    expect(client).toContain('sidebarRightTabs')
    expect(sources('client/ui-subagent')).toContain('dsh-resource://subagentchat')
    expect(sources('client/ui-primitives')).toContain('export class SettingsFormModel')
    expect(client).toMatch(/locale\.register|register\(ns|registerLocale/)
  })

  it('UI-11 the props Asuna reads in a tool call view are still passed', () => {
    const client = sources(...CLIENT)
    for (const prop of ['toolName', 'phase', 'argsRaw', 'isError', 'useDisclosure']) expect(client, prop).toContain(prop)
    for (const prop of ['useTurnData', 'renderSlot', 'SessionProvider']) expect(client, prop).toContain(prop)
  })
})
