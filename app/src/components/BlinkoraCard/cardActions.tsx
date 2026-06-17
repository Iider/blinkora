import { Tooltip } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy } from "../Common/Copy";
import { Icon } from '@/components/Common/Iconify/icons';
import { Note } from '@shared/lib/types';
import { BlinkoraStore } from '@/store/blinkoraStore';
import { AnnotationTriggerButton } from './annotationButton';
import { HistoryButton } from '../BlinkoraNoteHistory/HistoryButton';
import { confirmDeleteNotes } from '@/lib/noteDeletion';
import { PromiseCall } from '@/store/standard/PromiseState';
import { api } from '@/lib/trpc';

interface CardActionButtonsProps {
  blinkoraItem: Note;
  blinkora: BlinkoraStore;
  iconSize?: number | string;
  className?: string;
  itemClassName?: string;
  showHistory?: boolean;
  onDeleted?: () => void;
  onTrashed?: () => void;
}

const buildCopyContent = (note: Note) => {
  const attachments = note.attachments
    ?.map(item => window.location.origin + item.path)
    .join('\n');

  return [note.content, attachments].filter(Boolean).join('\n');
};

export const CardActionButtons = observer(({
  blinkoraItem,
  blinkora,
  iconSize = 16,
  className = '',
  itemClassName = '',
  showHistory = true,
  onDeleted,
  onTrashed,
}: CardActionButtonsProps) => {
  const { t } = useTranslation();

  const handleDelete = (e: MouseEvent) => {
    e.stopPropagation();
    if (blinkoraItem.isRecycle) {
      confirmDeleteNotes({ ids: [blinkoraItem.id!], onDeleted });
      return;
    }

    PromiseCall(api.notes.trashMany.mutate({ ids: [blinkoraItem.id!] })).then(() => {
      blinkora.updateTicker++;
      onTrashed?.();
    });
  };

  return (
    <div data-drag-ignore="true" className={`flex items-center gap-2 ${className}`}>
      <div className={itemClassName}>
        <Copy
          size={Number(iconSize)}
          content={buildCopyContent(blinkoraItem)}
        />
      </div>

      <AnnotationTriggerButton
        blinkoraItem={blinkoraItem}
        className={itemClassName}
        size={iconSize}
      />

      {showHistory && !!blinkoraItem._count?.histories && blinkoraItem._count.histories > 0 && (
        <div data-drag-ignore="true" className={itemClassName}>
          <HistoryButton
            noteId={blinkoraItem.id!}
            className="cursor-pointer text-desc hover:text-primary"
          />
        </div>
      )}

      <Tooltip content={blinkoraItem.isRecycle ? t('delete') : t('trash')} delay={1000}>
        <button
          type="button"
          data-drag-ignore="true"
          className={`inline-flex cursor-pointer items-center border-0 bg-transparent p-0 leading-none text-desc hover:text-red-500 ${itemClassName}`}
          onClick={handleDelete}
        >
          <Icon
            icon="mingcute:delete-2-line"
            width={iconSize}
            height={iconSize}
          />
        </button>
      </Tooltip>
    </div>
  );
});
