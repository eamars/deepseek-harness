/** Reusable native Chat occurrences over the current authorized Session binding. */
import { useEffect, useMemo } from 'react'
import { MarkdownDelegateProvider } from '@deepseek-ai/dsh-client-ui-primitives'
import { fileMediaUrl, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { NodeKey, RenderEntry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatContentProps, ChatEntryProps, ChatFlowHookContext } from '../contract/slots.ts'
import { ChatView } from './ChatView.tsx'
import css from './ChatView.module.css'

/** A fragment has no viewport of its own: its folds apply at once, without the enclosing viewport's motion. */
const FRAGMENT_FLOW: ChatFlowHookContext = {
  motion: {
    collapse: (_element, done) => { done() },
    reveal: () => {},
    cancelMotion: () => {},
  },
}

/** @param props - current Conversation owner. @returns the native main Chat occurrence. */
export function ChatEntry(props: ChatEntryProps) {
  return props.renderFactorySlot('conversation.chat.content', { variant: 'main',
    inspectCall: props.inspectCall, viewRequest: props.viewRequest,
    openView: props.openView, completeViewRequest: props.completeViewRequest })
}

/** @param props - source binding and occurrence selection. @returns native transcript records. */
export function ChatContent(props: ChatContentProps) {
  return props.variant === 'main' ? <ChatView {...props} /> : <ChatFragment {...props} />
}

function ChatFragment(props: ChatContentProps & { variant: 'fragment' }) {
  const { useChat, useSession, renderSlot, loadImage, openFile, openSkill, openExternalLink,
    fileMentions, forkAt, loadOlder, loadThrough, after, through, kinds, t } = props
  const order = useChat(s => s.order)
  const nodeStore = useChat(s => s.nodes)
  const cwd = props.useSessions(s => s.byId[props.sessionId]?.cwd)
  const fileImages = useMemo(() => ({
    resolve: (path: string) => fileMediaUrl(document.baseURI, resolveWorkspacePath(cwd, path)),
    labels: {
      open: t('image.open'), loading: t('image.loading'), failed: t('image.failed'),
      dialog: t('image.dialog'), close: t('image.close'),
    },
  }), [cwd, t])
  const hasMore = useSession(s => s.hasMore)
  const loadingOlder = useSession(s => s.loadingOlder)
  const openError = useSession(s => s.openError)
  // The range's own Nodes: the Session's process groups span a whole Turn, which several fragments may share.
  const entries = useMemo<readonly RenderEntry[]>(() => order.flatMap((key) => {
    const node = nodeStore.get(key)
    return node !== undefined && kinds.some(kind => kind === node.kind)
      && (after === undefined || node.anchorSeq > after)
      && (through === undefined || node.anchorSeq <= through)
      ? [{ kind: 'node' as const, key: key as NodeKey }] : []
  }), [order, nodeStore, after, through, kinds])
  useEffect(() => {
    if (through !== undefined) void loadThrough(through)
  }, [through, loadThrough])
  const first = order[0] === undefined ? undefined : nodeStore.get(order[0])
  return <div data-chat-fragment={props.sessionId} style={{ display: 'contents' }}>
    {openError !== null && <div className={css.openError}>
      {t('chat.loadError', { message: openError.message, code: openError.code })}
    </div>}
    {hasMore && (after === undefined || first === undefined || first.anchorSeq > after) &&
      <div className={css.older}><button type="button" disabled={loadingOlder} onClick={loadOlder}>
        {loadingOlder ? t('loading') : t('chat.loadOlder')}
      </button></div>}
    <MarkdownDelegateProvider openExternalLink={openExternalLink} openFile={openFile} fileImages={fileImages}>
      {renderSlot('conversation.chat.flow', {
        entries, pendingInputs: [], lastInputTurn: undefined, deferCollapse: false, fragment: true,
        cwd, openFile, openSkill, inspectCall: undefined, forkAt, loadImage, fileMentions,
      }, { hookContext: FRAGMENT_FLOW })}
    </MarkdownDelegateProvider>
  </div>
}
