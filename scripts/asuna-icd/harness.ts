/**
 * Shared fixture for the Asuna ICD specs: a Host core with a scripted model, mounted the way a DSH Host mounts it.
 * Each spec owns its context and disposes it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

export const MODEL = { provider: 'scripted', model: 'scripted' } as const

export type Reply = StreamChunk[] | ((options: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>)

/** A model that answers each request with the next scripted reply and records every request it receives. */
export class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: Reply[] = [], private readonly info: Partial<LlmResolvedModelInfo> = {}) {
    super()
  }

  push(...replies: Reply[]): void {
    this.script.push(...replies)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, ...this.info })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedModel: no reply left')
    for (const chunk of typeof entry === 'function' ? await entry(options) : entry) yield chunk
  }
}

export function text(reply: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: reply },
    { type: 'block-end', index: 0, block: { type: 'text', text: reply } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function toolCall(id: string, name: string, args: object): StreamChunk[] {
  const callId = ToolCallId(id)
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: json } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** A temporary folder the spec owns, removed by the returned disposer. */
export function scratch(): { root: string; remove: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'asuna-icd-'))
  return { root, remove: () => { rmSync(root, { recursive: true, force: true }) } }
}

/**
 * A Host core: model runtime, sessions, projections, system prompt, tools, agents and the agent loop; with `root`,
 * sessions persist there through DSH's JSONL persistence.
 */
export async function host(
  model: ScriptedModel = new ScriptedModel(),
  options: { root?: string } = {},
): Promise<{ ctx: Context; model: ScriptedModel }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  if (options.root !== undefined) await ctx.plugin(JsonlSessionPersistence, { root: options.root, compression: 'none' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // 0.2.2: tool calls run only through a mounted executor; the Web bundle mounts this one.
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter([MODEL.provider], model)
  return { ctx, model }
}

/** Open an agent on a session id the caller chooses (SES-1). */
export async function open(ctx: Context, id: string, setup?: (agentCtx: Context) => void | Promise<void>): Promise<Agent> {
  const handle = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: { ...MODEL }, ...setup ? { setup } : {} })
  return handle.agent
}

export function person(words: string, source: Record<string, unknown> = {}) {
  return createUserMessage({ content: [{ type: 'text', text: words }], source: { kind: 'user', ...source } as never })
}

export function idle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** A tool whose value is a string, rendered as one text block, as Asuna defines its tools (TL-2). */
export function textTool(
  name: string,
  execute: (args: never, exec: ToolRunContext) => Promise<string> | string,
  extra: Record<string, unknown> = {},
) {
  return defineTool({
    name,
    description: name,
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    execute,
    ...extra,
  } as never)
}

export function wordsOf(options: GenerateOptions): string {
  return JSON.stringify(options.messages)
}
