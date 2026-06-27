import { Icon } from '@/components/Common/Iconify/icons';
import { Tooltip } from '@heroui/react';
import { LeftCickMenu, ShowEditTimeModel } from "../BlinkoraRightClickMenu";
import { BlinkoraStore } from '@/store/blinkoraStore';
import { Note, NoteType } from '@shared/lib/types';
import dayjs from '@/lib/dayjs';
import { useTranslation } from 'react-i18next';
import { _ } from '@/lib/lodash';
import { useIsIOS } from '@/lib/hooks';
import { observer } from 'mobx-react-lite';
import { CardActionButtons } from './cardActions';

interface CardHeaderProps {
  blinkoraItem: Note;
  blinkora: BlinkoraStore;
  isExpanded?: boolean;
}

export const CardHeader = observer(({
  blinkoraItem,
  blinkora,
  isExpanded,
}: CardHeaderProps) => {
  const { t } = useTranslation();
  const iconSize = isExpanded ? '20' : '16';
  const isIOSDevice = useIsIOS();
  const actionVisibleClass = isIOSDevice
    ? 'opacity-100'
    : 'opacity-0 group-hover/card:opacity-100 group-hover/card:translate-x-0 translate-x-1';

  const handleTodoToggle = async (e) => {
    e.stopPropagation();

    try {
      if (blinkoraItem.isArchived) {
        await blinkora.upsertNote.call({
          id: blinkoraItem.id,
          isArchived: false
        });
        blinkora.updateTicker++
      } else {
        await blinkora.upsertNote.call({
          id: blinkoraItem.id,
          isArchived: true
        });
        blinkora.updateTicker++
      }
    } catch (error) {
      console.error('Error toggling TODO status:', error);
    }
  };

  return (
    <div
      className={`flex cursor-pointer items-center ${isExpanded ? 'mb-4' : 'mb-1'}`}
      title={t('flip-to-back')}
    >
      <div className={`flex items-center w-full gap-1 ${isExpanded ? 'text-base' : 'text-xs'}`}>
        {blinkoraItem.type === NoteType.TODO && (
          <Tooltip content={blinkoraItem.isArchived ? t('restore') : t('complete')} delay={1000}>
            <div
              data-drag-ignore="true"
              className="flex items-center cursor-pointer"
              onClick={handleTodoToggle}
            >
              <Icon
                icon={blinkoraItem.isArchived ? "solar:refresh-circle-bold" : "mdi:circle-outline"}
                className={`${blinkoraItem.isArchived ? 'text-blue-500' : 'text-green-500'} hover:opacity-80`}
                width="16"
                height="16"
              />
            </div>
          </Tooltip>
        )}

        <Tooltip content={t('edit-time')} delay={1000}>
          <div 
            data-drag-ignore="true"
            className={`${isExpanded ? 'text-sm' : 'text-xs'} text-desc select-text transition-colors`}
            onClick={(e) => {
              e.stopPropagation();
              const selection = window.getSelection();
              if (
                selection &&
                !selection.isCollapsed &&
                e.currentTarget.contains(selection.anchorNode) &&
                e.currentTarget.contains(selection.focusNode)
              ) {
                return;
              }
              blinkora.curSelectedNote = _.cloneDeep(blinkoraItem);
              ShowEditTimeModel();
            }}
          >
            {blinkora.config.value?.timeFormat == 'relative'
              ? dayjs(blinkora.config.value?.isOrderByCreateTime ? blinkoraItem.createdAt : blinkoraItem.updatedAt).fromNow()
              : dayjs(blinkora.config.value?.isOrderByCreateTime ? blinkoraItem.createdAt : blinkoraItem.updatedAt).format(blinkora.config.value?.timeFormat ?? 'YYYY-MM-DD HH:mm:ss')
            }
          </div>
        </Tooltip>

        <CardActionButtons
          blinkoraItem={blinkoraItem}
          blinkora={blinkora}
          iconSize={iconSize}
          className={`ml-auto ${actionVisibleClass}`}
          showMarkdownExport
        />

        {blinkoraItem.isTop && (
          <Icon
            className={isIOSDevice ? 'ml-[10px] text-[#EFC646]' : "ml-auto group-hover/card:ml-2 text-[#EFC646]"}
            icon="solar:bookmark-bold"
            width={iconSize}
            height={iconSize}
          />
        )}

        <span data-drag-ignore="true" className="contents">
          <LeftCickMenu
            className={isIOSDevice ? 'ml-[10px]' : (blinkoraItem.isTop ? "ml-[10px]" : 'ml-auto group-hover/card:ml-2')}
            onTrigger={() => { blinkora.curSelectedNote = _.cloneDeep(blinkoraItem) }}
          />
        </span>
      </div>
    </div>
  );
});
