/** Reusable native Chat occurrences over the current authorized Session binding. */
import { useCallback, useEffect, useMemo } from 'react'
import { MarkdownDelegateProvider } from '@deepseek-ai/dsh-client-ui-primitives'
import { fileMediaUrl, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { NodeKey, RenderEntry, RenderMessageImages } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatContentProps, ChatEntryProps } from '../contract/slots.ts'
import { ChatNodeList, ChatView } from './ChatView.tsx'
import css from './ChatView.module.css'

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
  const { useChat, useSession, useConversation, useChatGroup, useChatNode, useChatNodeProcess, usePresentation,
    useStore, actions, renderSlot, loadImage, openFile, openSkill, openExternalLink,
    fileMentions, forkAt, loadOlder, loadThrough, after, through, kinds, t } = props
  const order = useChat(s => s.order)
  const nodeStore = useChat(s => s.nodes)
  // The same grouped entries the main Chat renders, so a fragment folds and discloses exactly like it.
  const grouped = useConversation(snapshot => snapshot.views.grouped('chat'))
  const groupedEntries = useConversation(snapshot => snapshot.views.grouped('chat')?.entries)
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
  const entries = useMemo<readonly RenderEntry[]>(() => (groupedEntries
    ?? order.map(key => ({ kind: 'node' as const, key: key as NodeKey }))).filter(entry => {
    // A group belongs to the occurrence holding its first member.
    const key = entry.kind === 'node' ? entry.key : grouped?.groupSource(entry.key).getSnapshot()?.members[0]?.key
    const node = key === undefined ? undefined : nodeStore.get(key)
    return node !== undefined && kinds.some(kind => kind === node.kind)
      && (after === undefined || node.anchorSeq > after)
      && (through === undefined || node.anchorSeq <= through)
  }), [groupedEntries, grouped, order, nodeStore, after, through, kinds])
  useEffect(() => {
    if (through !== undefined) void loadThrough(through)
  }, [through, loadThrough])
  const renderMessageImages = useCallback<RenderMessageImages>(
    owner => renderSlot('conversation.message.images', { ...owner, loadImage }), [renderSlot, loadImage])
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
      <ChatNodeList entries={entries} pendingInputs={[]} lastInputTurn={undefined} nodeStore={nodeStore}
        useChatGroup={useChatGroup} useChatNode={useChatNode} useChatNodeProcess={useChatNodeProcess}
        usePresentation={usePresentation} useStore={useStore} actions={actions} cwd={cwd}
        openFile={openFile} openSkill={openSkill} inspectCall={undefined} forkAt={forkAt}
        loadImage={loadImage} renderMessageImages={renderMessageImages}
        fileMentions={fileMentions} renderSlot={renderSlot} t={t} />
    </MarkdownDelegateProvider>
  </div>
}
