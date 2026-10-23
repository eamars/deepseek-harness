import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { selectCompactableRange } from '@deepseek-ai/dsh-compaction-basic/src/region.ts'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import LlmRuntime, {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'

const MODEL = 'mock'
const SIGNAL = new AbortController().signal
const PROMPT = 'older conversation history '.repeat(60)

class FixedSummaryEngine extends BasicCompactionEngine {
  override summarize(_input: SummarizationInput, _agent: Agent, _signal?: AbortSignal): Promise<SummaryResult> {
    return Promise.resolve({ summary: [{ type: 'text', text: 'checkpoint' }], provider: MODEL, model: MODEL })
  }
}

class TextAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function service(): { ctx: Context; compact: FixedSummaryEngine } {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  void new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], new TextAdapter())
  ctx.sessions.flush = () => Promise.resolve(false)
  return { ctx, compact: new FixedSummaryEngine(ctx, { auto: false }) }
}

function idleAgent(session: Session): Agent {
  return {
    session,
    options: { provider: MODEL, model: MODEL },
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return task(new AbortController().signal)
    },
  } as unknown as Agent
}

/**
 * Two closed text turns, then a closed third turn of several surface nodes:
 * prompt, a tool call, its result, and a final answer.
 */
function threeTurns(): { session: Session; turn3: { user: SessionSeq; call: SessionSeq; result: SessionSeq; answer: SessionSeq } } {
  const session = Session.create(SessionId('keep-from'))
  const user = (turn: number): SessionSeq => session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `${PROMPT} ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
  const answer = (turn: number, step: number, content: Parameters<typeof createAssistantMessage>[0]['content']): SessionSeq =>
    session.append('assistant/message', {
      stream: [],
      turn,
      step,
      message: createAssistantMessage({ content, source: { provider: MODEL, model: MODEL } }),
    }, { surfaceOp: 'append' }).seq
  for (const turn of [1, 2]) {
    session.append('turn/start', { turn })
    user(turn)
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', { header: { config: { provider: MODEL, model: MODEL } }, reason: 'initial' })
    }
    answer(turn, 1, [{ type: 'text', text: `answer ${turn}` }])
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const callId = ToolCallId('turn-3-read')
  session.append('turn/start', { turn: 3 })
  const user3 = user(3)
  session.append('step/start', { turn: 3, step: 1 })
  const call = answer(3, 1, [
    { type: 'text', text: 'first part of turn 3' },
    { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
  ])
  session.append('tool/call', { turn: 3, step: 1, callId, name: 'read', arguments: '{}' })
  const result = session.append('tool/result', {
    turn: 3,
    step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'result' }], isError: false }),
  }, { surfaceOp: 'append' }).seq
  session.append('step/end', { turn: 3, step: 1 })
  session.append('step/start', { turn: 3, step: 2 })
  const final = answer(3, 2, [{ type: 'text', text: 'last part of turn 3' }])
  session.append('step/end', { turn: 3, step: 2 })
  session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
  return { session, turn3: { user: user3, call, result, answer: final } }
}

/** Surface nodes after the replaced span: what stays verbatim. */
function keptTail(session: Session, end: SessionSeq): SessionSeq[] {
  const nodes = session.surface.nodes
  return nodes.slice(nodes.indexOf(end) + 1)
}

describe('compactNow keepFrom', () => {
  it('keeps the whole last turn verbatim from the given surface node', async () => {
    const { compact } = service()
    const { session, turn3 } = threeTurns()

    const result = await compact.compactNow(idleAgent(session), SIGNAL, undefined, { keepFrom: turn3.user })

    expect(result).not.toBeNull()
    expect(session.surface.nodes.slice(-4)).toEqual([turn3.user, turn3.call, turn3.result, turn3.answer])
    expect(result?.shadowedSeqs).not.toContain(turn3.user)
    expect(session.surface.nodes).toHaveLength(5)
  })

  it('walks back from an unbalanced keepFrom to the tool call it answers', async () => {
    const { ctx } = service()
    const { session, turn3 } = threeTurns()

    const range = selectCompactableRange(session, ctx.tokenMeter.measure(session), 0, turn3.result)

    expect(range).not.toBeNull()
    expect(keptTail(session, range!.end)).toEqual([turn3.call, turn3.result, turn3.answer])
  })

  it('returns null without a bracket when keepFrom leaves nothing before it', async () => {
    const { compact } = service()
    const { session } = threeTurns()
    const before = session.snapshotEvents().length

    const first = session.surface.nodes[0]!
    expect(await compact.compactNow(idleAgent(session), SIGNAL, undefined, { keepFrom: first })).toBeNull()
    expect(session.snapshotEvents()).toHaveLength(before)
  })

  it('refuses a keepFrom that is not a current surface node, writing nothing', async () => {
    const { compact } = service()
    const { session } = threeTurns()
    const before = session.snapshotEvents().length
    const notOnSurface = session.snapshotEvents().find(event => event.type === 'turn/start')!.seq

    await expect(compact.compactNow(idleAgent(session), SIGNAL, undefined, { keepFrom: notOnSurface }))
      .rejects.toThrow(/keepFrom/)
    expect(session.snapshotEvents()).toHaveLength(before)
  })

  it('without keepFrom selects exactly the fixed 0-token tail, as before', async () => {
    const { ctx, compact } = service()
    const plain = threeTurns()
    const withEmptyOptions = threeTurns()
    const expected = selectCompactableRange(plain.session, ctx.tokenMeter.measure(plain.session), 0)

    const a = await compact.compactNow(idleAgent(plain.session), SIGNAL)
    const b = await compact.compactNow(idleAgent(withEmptyOptions.session), SIGNAL, undefined, {})

    expect(expected).not.toBeNull()
    expect(a?.shadowedRange).toEqual(expected)
    expect(b?.shadowedRange).toEqual(expected)
    expect(plain.session.surface.nodes.slice(-1)).toEqual([plain.turn3.answer])
    expect(withEmptyOptions.session.surface.nodes.slice(-1)).toEqual([withEmptyOptions.turn3.answer])
  })
})
