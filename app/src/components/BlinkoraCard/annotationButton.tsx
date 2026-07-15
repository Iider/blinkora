import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@heroui/react';
import { Icon } from '@/components/Common/Iconify/icons';
import { api } from '@/lib/trpc';
import { RootStore } from '@/store';
import { BlinkoraStore } from '@/store/blinkoraStore';
import { DialogStore } from '@/store/module/Dialog';
import { PromiseCall } from '@/store/standard/PromiseState';
import { Note } from '@shared/lib/types';
import Editor from '@/components/Common/Editor';
import { MarkdownRender } from '@/components/Common/MarkdownRender';
import dayjs from '@/lib/dayjs';

const getCommentTitle = (label: string, count: number) => count > 0 ? `${label} (${count})` : label;

type Annotation = {
  id: number;
  content: string;
  createdAt: string;
  account?: {
    image?: string | null;
    name?: string | null;
    nickname?: string | null;
  } | null;
  replies?: Annotation[];
};

const AnnotationDialog = observer(({ note }: { note: Note }) => {
  const { t } = useTranslation();
  const [items, setItems] = useState<Annotation[]>([]);
  const [content, setContent] = useState('');
  const [replyTo, setReplyTo] = useState<Annotation | null>(null);
  const [editing, setEditing] = useState<Annotation | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [sending, setSending] = useState(false);

  const noteId = note.id!;
  const titleCount = hasLoaded ? items.length : ((note as any)._count?.comments ?? 0);

  const load = async () => {
    setLoading(true);
    try {
      const comments = await api.comments.list.query({ noteId });
      setItems(comments);
    } finally {
      setHasLoaded(true);
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [noteId]);

  const refreshNotes = () => {
    RootStore.Get(BlinkoraStore).updateTicker++;
  };

  const resetComposer = () => {
    setContent('');
    setReplyTo(null);
    setEditing(null);
  };

  const submitAnnotation = async (nextContent = content) => {
    const trimmed = nextContent.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      if (editing) {
        await PromiseCall(api.comments.update.mutate({ id: editing.id, content: trimmed }));
      } else {
        await PromiseCall(api.comments.create.mutate({
          noteId,
          content: trimmed,
          ...(replyTo ? { parentId: replyTo.id } : {}),
        }));
      }
      resetComposer();
      await load();
      refreshNotes();
    } finally {
      setSending(false);
    }
  };

  const deleteAnnotation = async (id: number) => {
    await PromiseCall(api.comments.delete.mutate({ id }));
    if (replyTo?.id === id || editing?.id === id) {
      resetComposer();
    }
    await load();
    refreshNotes();
  };

  const displayName = (item: Annotation) => item.account?.nickname || item.account?.name || t('default');

  const renderAnnotation = (item: Annotation, isReply = false) => {
    const name = displayName(item);
    const avatarText = name.slice(0, 1).toUpperCase();

    return (
      <div data-comment-id={item.id} className="flex gap-3">
        {item.account?.image ? (
          <img src={item.account.image} alt={name} className="mt-0.5 h-8 w-8 rounded-full object-cover" />
        ) : (
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            {avatarText}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{name}</span>
            <span className="text-xs text-desc">{dayjs(item.createdAt).fromNow()}</span>
            <div className="ml-auto flex items-center gap-1">
              {!isReply && (
                <Tooltip content={t('reply-to')} delay={800}>
                  <button
                    type="button"
                    aria-label={t('reply-to')}
                    className="flex cursor-pointer items-center border-0 bg-transparent p-1 text-desc hover:text-primary"
                    onClick={(event) => {
                      event.stopPropagation();
                      setEditing(null);
                      setReplyTo(item);
                      setContent('');
                    }}
                  >
                    <Icon icon="tabler:corner-down-right" width="16" height="16" />
                  </button>
                </Tooltip>
              )}
              <Tooltip content={t('edit')} delay={800}>
                <button
                  type="button"
                  aria-label={t('edit')}
                  className="flex cursor-pointer items-center border-0 bg-transparent p-1 text-desc hover:text-primary"
                  onClick={(event) => {
                    event.stopPropagation();
                    setReplyTo(null);
                    setEditing(item);
                    setContent(item.content);
                  }}
                >
                  <Icon icon="tabler:edit" width="16" height="16" />
                </button>
              </Tooltip>
              <Tooltip content={t('delete')} delay={800}>
                <button
                  type="button"
                  aria-label={t('delete')}
                  className="flex cursor-pointer items-center border-0 bg-transparent p-1 text-desc hover:text-danger"
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteAnnotation(item.id);
                  }}
                >
                  <Icon icon="mingcute:delete-2-line" width="16" height="16" />
                </button>
              </Tooltip>
            </div>
          </div>
          <div className="mt-1 text-sm">
            <MarkdownRender content={item.content} />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-5" onClick={(e) => e.stopPropagation()}>
      <div className="text-lg font-semibold">{getCommentTitle(t('comment'), titleCount)}</div>

      <div className="flex max-h-[40vh] flex-col gap-4 overflow-y-auto pr-1">
        {loading && <div className="py-8 text-center text-sm text-desc">{t('loading')}</div>}
        {!loading && items.length === 0 && <div className="py-8 text-center text-sm text-desc">{t('no-comments-yet')}</div>}
        {items.map((item) => (
          <div key={item.id} data-comment-thread-id={item.id} className="flex flex-col gap-3">
            {renderAnnotation(item)}
            {item.replies?.map((reply) => (
              <div key={reply.id} className="ml-7 border-l border-divider pl-3">
                {renderAnnotation(reply, true)}
              </div>
            ))}
          </div>
        ))}
      </div>

      {(replyTo || editing) && (
        <div data-comment-composer-context="true" className="flex items-center gap-2 text-sm text-desc">
          <span>{editing ? t('edit') : `${t('reply-to')} ${displayName(replyTo!)}`}</span>
          <button
            type="button"
            aria-label={t('cancel')}
            className="ml-auto cursor-pointer border-0 bg-transparent p-1 text-desc hover:text-foreground"
            onClick={resetComposer}
          >
            <Icon icon="ph:x-bold" width="14" height="14" />
          </button>
        </div>
      )}
      <div style={{ '--min-editor-height': '96px' } as React.CSSProperties}>
        <Editor
          mode="comment"
          content={content}
          onChange={setContent}
          onSend={async ({ content }) => submitAnnotation(content)}
          isSendLoading={sending}
          hiddenToolbar
        />
      </div>
    </div>
  );
});

export const showAnnotationDialog = (note: Note) => {
  DialogStore.show({
    size: '2xl',
    title: '',
    content: <AnnotationDialog note={note} />,
  });
};

export const SimpleCommentList = observer(({ blinkoraItem }: { blinkoraItem: Note & { comments?: any[] } }) => {
  const { t } = useTranslation();
  const commentList = blinkoraItem.comments?.slice(0, 1);

  if (!commentList || commentList.length === 0) return null;

  return (
    <div className="mt-1 rounded-lg bg-secondbackground px-1 py-2">
      {commentList.map((comment) => {
        const displayName = comment.guestName || comment.account?.nickname || comment.account?.name || t('default');

        return (
          <div key={comment.id} className="pb-[2px]">
            <div className="ml-1 flex-1 text-xs">
              <span className="mr-1 font-bold text-primary"> {displayName}:</span>
              {comment.content}
            </div>
          </div>
        );
      })}
    </div>
  );
});

export const AnnotationTriggerButton = observer(({
  blinkoraItem,
  className = '',
  size = 16
}: {
  blinkoraItem: Note;
  className?: string;
  size?: number | string;
}) => {
  const { t } = useTranslation();
  const count = (blinkoraItem as any)._count?.comments ?? 0;
  const label = count ? t('annotations-count', { count }) : t('add-annotation');

  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    showAnnotationDialog(blinkoraItem);
  };

  return (
    <Tooltip content={count ? t('annotations-count', { count }) : t('add-annotation')} delay={800}>
      <button
        type="button"
        aria-label={label}
        data-drag-ignore="true"
        className={`flex cursor-pointer items-center border-0 bg-transparent p-0 leading-none text-desc hover:text-primary ${className}`}
        onClick={open}
      >
        <Icon icon="mingcute:comment-line" width={size} height={size} />
      </button>
    </Tooltip>
  );
});

export const AnnotationCountBadge = observer(({ blinkoraItem }: { blinkoraItem: Note }) => {
  const { t } = useTranslation();
  const count = (blinkoraItem as any)._count?.comments ?? 0;

  if (count <= 0) return null;

  return (
    <Tooltip content={t('annotations-count', { count })} delay={800}>
      <div data-drag-ignore="true" className="flex items-center gap-1 text-desc" onClick={(e) => e.stopPropagation()}>
        <Icon icon="mingcute:comment-line" width="16" height="16" />
        <span className="text-xs font-medium">{count}</span>
      </div>
    </Tooltip>
  );
});
