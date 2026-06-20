import { api } from "@/lib/trpc"
import { BlinkoraItem } from "./index"
import { RootStore } from "@/store"
import { DialogStandaloneStore } from "@/store/module/DialogStandalone"
import { BlinkoraCard } from "./index"
import { getDisplayTime } from "@/lib/helper"
import { Icon } from '@/components/Common/Iconify/icons'
import { cn } from "@heroui/theme"
import { Tooltip } from "@heroui/react"
import { useTranslation } from "react-i18next"
import { getReferencePreviewText } from "./cardPreview"

type ReferenceDirection = 'outgoing' | 'incoming' | 'mutual';

type ReferenceDisplayItem = {
  key: string;
  noteId: number;
  note?: any;
  direction: ReferenceDirection;
}

const toNumber = (value: unknown) => {
  if (value == null || value === '') return undefined;
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

const getOutgoingNoteId = (item: any) => toNumber(item?.toNoteId ?? item?.toId ?? item?.toNote?.id);
const getIncomingNoteId = (item: any) => toNumber(item?.fromNoteId ?? item?.fromId ?? item?.fromNote?.id);

const buildReferenceItems = (blinkoraItem: BlinkoraItem): ReferenceDisplayItem[] => {
  const outgoing = blinkoraItem.references ?? [];
  const incoming = blinkoraItem.referencedBy ?? [];
  const incomingByNoteId = new Map<number, any>();

  incoming.forEach((item) => {
    const noteId = getIncomingNoteId(item);
    if (noteId != null && !incomingByNoteId.has(noteId)) {
      incomingByNoteId.set(noteId, item);
    }
  });

  const mutualNoteIds = new Set<number>();
  const displayItems: ReferenceDisplayItem[] = [];

  outgoing.forEach((item, index) => {
    const noteId = getOutgoingNoteId(item);
    if (noteId == null) return;

    const incomingItem = incomingByNoteId.get(noteId);
    if (incomingItem) {
      mutualNoteIds.add(noteId);
      displayItems.push({
        key: `mutual-${noteId}`,
        noteId,
        note: item.toNote ?? incomingItem.fromNote,
        direction: 'mutual',
      });
      return;
    }

    displayItems.push({
      key: `outgoing-${noteId}-${item.id ?? index}`,
      noteId,
      note: item.toNote,
      direction: 'outgoing',
    });
  });

  incoming.forEach((item, index) => {
    const noteId = getIncomingNoteId(item);
    if (noteId == null || mutualNoteIds.has(noteId)) return;

    displayItems.push({
      key: `incoming-${noteId}-${item.id ?? index}`,
      noteId,
      note: item.fromNote,
      direction: 'incoming',
    });
  });

  return displayItems;
}

export const ReferencesContent = ({ blinkoraItem, className }: { blinkoraItem: BlinkoraItem, className?: string }) => {
  const { t } = useTranslation()
  const referenceItems = buildReferenceItems(blinkoraItem);

  if (referenceItems.length === 0) return null

  const renderDirectionIcon = (direction: ReferenceDirection) => {
    const tooltip = direction === 'mutual'
      ? t('mutual-reference')
      : direction === 'incoming'
        ? t('reference-by')
        : t('reference');
    const icon = direction === 'mutual' ? 'ri:exchange-2-line' : 'iconamoon:arrow-top-right-1';

    return (
      <Tooltip content={tooltip} delay={1000}>
        <Icon
          icon={icon}
          className={cn('text-primary ml-auto', direction === 'incoming' && 'rotate-180')}
          width="16"
          height="16"
        />
      </Tooltip>
    )
  }

  return <div className={cn('flex flex-col gap-2', className)}>
    {referenceItems.map(item => {
      return <div key={item.key} className='blinkora-reference flex flex-col gap-1 rounded-md !p-2' onClick={async (e) => {
        e.stopPropagation()
        const note = await api.notes.detail.mutate({ id: item.noteId })
        RootStore.Get(DialogStandaloneStore).setData({
          isOpen: true,
          onlyContent: true,
          showOnlyContentCloseButton: true,
          size: '4xl',
          content: <BlinkoraCard blinkoraItem={note!} />
        })
      }}>
        <div className='text-desc text-xs ml-1 select-none flex'>
          {getDisplayTime(item.note?.createdAt, item.note?.updatedAt)}
          {renderDirectionIcon(item.direction)}
        </div>
        <div className='text-default-700 text-xs ml-1 select-none line-clamp-3 '>{getReferencePreviewText(item.note?.content)}</div>
      </div>
    })}
  </div>
}
