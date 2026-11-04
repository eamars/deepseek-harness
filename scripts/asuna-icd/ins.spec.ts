/**
 * INS and PEER: source checks. Each one checks that DSH still names a CLI flag, profile row, home path or gateway
 * route Asuna's launcher, installer and peer channel rely on (README.md, INS and PEER). Installing a real plugin,
 * starting a Host and following a peer are checked at the upgrade routine's review step.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { host, open, person, scratch, ScriptedModel, text } from './harness.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8')

const SKIP = new Set(['node_modules', 'lib', 'dist', 'tests'])

/** Every TypeScript source file under a folder, skipping installed and built trees. */
function walk(folder: string): string[] {
  if (!existsSync(folder)) return []
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : walk(join(folder, entry.name))
    return /\.(ts|tsx)$/.test(entry.name) ? [join(folder, entry.name)] : []
  })
}

/** Every source file under the given folders, joined. */
function sources(...folders: string[]): string {
  return folders.flatMap(folder => walk(join(ROOT, folder))).map(file => readFileSync(file, 'utf8')).join('\n')
}

describe('INS. Install and composition (source checks)', () => {
  it('INS-1 INS-6 the CLI entry, its profile and Host flags and its environment variables are still named so', () => {
    expect((JSON.parse(read('apps/cli/package.json')) as { bin?: unknown }).bin).toMatchObject({ dsh: 'lib/bin.js' })
    const cli = sources('apps/cli/src')
    for (const flag of ['from-default-profile', 'DSH_HOME', 'DSH_TELEMETRY_DISABLED']) expect(cli, flag).toContain(flag)
    expect(sources('apps/cli/src', 'packages/bundle', 'apps/desktop-host/src')).toContain('no-open')
    expect(sources('packages/boot/plugin-manager/src')).toContain('\'add\'')
  })

  it('INS-4 the shipped profile rows Asuna disables, configures or reads keep their ids and keys', () => {
    const base = read('packages/bundle/base/cordis.patch.yml') + read('packages/bundle/web-app/cordis.patch.yml')
    for (const id of ['session-persistence-jsonl', 'web', 'agent-preset-registry', 'agent-default-model', 'session-title-llm']) {
      expect(base, id).toMatch(new RegExp(`id: ${id}\\b`))
    }
    expect(base).toContain('searchProvider')
    expect(base).toContain('fetchProvider')
    expect(sources('packages/boot/app-boot/src', 'packages/util/home-paths/src')).toContain('dshHomePath')
  })

  it('INS-5 a profile\'s editable layer is still its cordis.patch.yml', () => {
    expect(sources('apps/cli/src')).toContain('cordis.patch.yml')
  })

  it('INS-7 DSH home still keeps sessions, the projection cache and writer locks where Asuna\'s launcher tidies them', () => {
    expect(sources('packages/session/session-projection-cache/src')).toContain('session_projcache')
    expect(sources('packages/util', 'packages/boot', 'packages/storage')).toMatch(/\.lock['"`]/)
  })
})

describe('INS. DSH home (behaviour)', () => {
  it('INS-7 each persisted session is one folder named by its id, one level under a project folder', async () => {
    const folder = scratch()
    const run = await host(new ScriptedModel([text('ok')]), { root: folder.root })
    try {
      const agent = await open(run.ctx, 'ins-7-session')
      agent.followup(person('go'))
      await agent.whenIdle()
      await run.ctx.sessions.flush(agent.session)
      const found = readdirSync(folder.root, { withFileTypes: true }).filter(entry => entry.isDirectory())
        .flatMap(project => readdirSync(join(folder.root, project.name), { withFileTypes: true })
          .filter(entry => entry.isDirectory() && entry.name === 'ins-7-session'))
      expect(found).toHaveLength(1)
    } finally {
      await run.ctx.fiber.dispose()
      folder.remove()
    }
  })
})

describe('PEER. Another DSH Web Host (source checks)', () => {
  it('PEER-1 a session is prompted over the gateway as a queued client request carrying its request id', () => {
    const api = sources('packages/api/session-controller/src', 'packages/api/gateway/src')
    expect(api).toContain('client-request')
    expect(api).toContain('rpcId')
    expect(api).toContain('\'queue\'')
    expect(api).toMatch(/['"]session\/prompt['"]|prompt\(/)
  })

  it('PEER-2 a session is followed over the gateway\'s multiplexed stream', () => {
    expect(sources('packages/api/gateway/src')).toContain('remote.mux')
    expect(sources('packages/client/connection/src', 'packages/api/session-controller/src')).toContain('session/follow')
  })
})

describe('INS. Plugin compatibility (behaviour)', () => {
  it('INS-3 a plugin whose DSH peers all name the Host\'s version passes; one naming another version is refused', () => {
    const runtime = getDshRuntimeVersion()
    const plugin = (peer: string) => ({ name: '@asuna/icd-probe', version: '1.0.0', peerDependencies: {
      '@deepseek-ai/dsh-agent': peer, '@deepseek-ai/dsh-llm': peer, '@deepseek-ai/cordis': '^4.0.0' } })
    expect(evaluatePluginCompatibility(plugin(runtime), {}, runtime)).toBeUndefined()
    const refused = evaluatePluginCompatibility(plugin('0.0.1'), {}, runtime)
    expect(refused?.exempted).toBe(false)
    expect(Object.keys(refused?.requirements ?? {})).toEqual(expect.arrayContaining(['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm']))
  })
})
