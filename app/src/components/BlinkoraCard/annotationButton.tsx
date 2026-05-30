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

const AnnotationDialog = observer(({ note }: { note: Note }) => {
  const { t } = useTranslation();
  const [items, setItems] = useState<any[]>([]);
  const [content, setContent] = useState('');
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

  const createAnnotation = async (nextContent = content) => {
    const trimmed = nextContent.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      await PromiseCall(api.comments.create.mutate({ noteId, content: trimmed }));
      setContent('');
      await load();
      refreshNotes();
    } finally {
      setSending(false);
    }
  };

  const deleteAnnotation = async (id: number) => {
    await PromiseCall(api.comments.delete.mutate({ id }));
    await load();
    refreshNotes();
  };

  return (
    <div className="flex flex-col gap-5" onClick={(e) => e.stopPropagation()}>
      <div className="text-lg font-semibold">{getCommentTitle(t('comment'), titleCount)}</div>

      <div className="flex max-h-[40vh] flex-col gap-4 overflow-y-auto pr-1">
        {loading && <div className="py-8 text-center text-sm text-desc">{t('loading')}</div>}
        {!loading && items.length === 0 && <div className="py-8 text-center text-sm text-desc">{t('no-comments-yet')}</div>}
        {items.map((item) => {
          const account = item.account;
          const displayName = account?.nickname || account?.name || t('default');
          const avatarText = displayName.slice(0, 1).toUpperCase();

          return (
            <div key={item.id} className="flex gap-3">
              {account?.image ? (
                <img src={account.image} alt={displayName} className="mt-0.5 h-8 w-8 rounded-full object-cover" />
              ) : (
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  {avatarText}
                </div>
              )}

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{displayName}</span>
                  <span className="text-xs text-desc">{dayjs(item.createdAt).fromNow()}</span>
                  <Tooltip content={t('delete')} delay={800}>
                    <button
                      type="button"
                      className="ml-auto flex cursor-pointer items-center border-0 bg-transparent p-1 text-desc hover:text-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteAnnotation(item.id);
                      }}
                    >
                      <Icon icon="mingcute:delete-2-line" width="16" height="16" />
                    </button>
                  </Tooltip>
                </div>
                <div className="mt-1 text-sm">
                  <MarkdownRender content={item.content} />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ '--min-editor-height': '96px' } as React.CSSProperties}>
        <Editor
          mode="comment"
          content={content}
          onChange={setContent}
          onSend={async ({ content }) => createAnnotation(content)}
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

export const AnnotationTriggerButton = observer(({ blinkoraItem, className = '' }: { blinkoraItem: Note; className?: string }) => {
  const { t } = useTranslation();
  const count = (blinkoraItem as any)._count?.comments ?? 0;

  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    showAnnotationDialog(blinkoraItem);
  };

  return (
    <Tooltip content={count ? t('annotations-count', { count }) : t('add-annotation')} delay={800}>
      <button
        type="button"
        data-drag-ignore="true"
        className={`flex cursor-pointer items-center border-0 bg-transparent p-0 leading-none text-desc hover:text-primary ${className}`}
        onClick={open}
      >
        <Icon icon="mingcute:comment-line" width="16" height="16" />
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
