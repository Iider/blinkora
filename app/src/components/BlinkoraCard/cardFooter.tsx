import { Icon } from '@/components/Common/Iconify/icons';
import { Tooltip } from '@heroui/react';
import { Note, NoteType } from '@shared/lib/types';
import { BlinkoraStore } from '@/store/blinkoraStore';
import { useTranslation } from 'react-i18next';
import { _ } from '@/lib/lodash';
import { BlinkoraItem } from '.';
import { RootStore } from '@/store';
import dayjs from '@/lib/dayjs';
import { AnnotationCountBadge } from './annotationButton';
import { NoteTypePicker, getNoteTypeOption } from '../Common/NoteTypePicker';

interface CardFooterProps {
  blinkoraItem: BlinkoraItem;
}

export const CardFooter = ({ blinkoraItem }: CardFooterProps) => {
  return (
    <div className="flex items-center">
      <ConvertTypeButton blinkoraItem={blinkoraItem} />
      <RightContent blinkoraItem={blinkoraItem} />
    </div>
  );
};

export const ConvertTypeButton = ({
  blinkoraItem,
  tooltip,
  toolTipClassNames,
  tooltipPlacement,
}: {
  blinkoraItem: BlinkoraItem & any;
  tooltip?: React.ReactNode;
  toolTipClassNames?: any;
  tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right';
}) => {
  const { t } = useTranslation();
  const blinkora = RootStore.Get(BlinkoraStore);

  const handleTypeChange = async (type: NoteType) => {
    blinkora.curSelectedNote = _.cloneDeep(blinkoraItem);
    if (blinkoraItem.type !== type) {
      await blinkora.upsertNote.call({
        id: blinkoraItem.id,
        type,
      });
    }
  };

  const getTodoStatus = () => {
    if (!blinkoraItem.metadata?.expireAt) {
      return { color: 'text-green-500', status: 'no-deadline' };
    }
    
    const expireDate = dayjs(blinkoraItem.metadata.expireAt);
    const now = dayjs();
    
    if (expireDate.isBefore(now)) {
      return { color: 'text-red-500', status: 'expired' };
    } else if (expireDate.diff(now, 'day') <= 3) {
      return { color: 'text-yellow-500', status: 'warning' };
    } else {
      return { color: 'text-green-500', status: 'normal' };
    }
  };

  const renderStatusText = () => {
    if (blinkoraItem.type === NoteType.TODO) {
      const todoStatus = getTodoStatus();
      return (
        <>
          {t('todo')}
          {blinkoraItem.metadata?.expireAt && (
            <span className={todoStatus.color}>
              {' · '}{getTimeDisplay()}
            </span>
          )}
          {blinkoraItem.isBlog ? ` · ${t('article')}` : ''}
          {blinkoraItem.isArchived ? ` · ${t('archived')}` : ''}
          {blinkoraItem.isOffline ? ` · ${t('offline')}` : ''}
        </>
      );
    }

    if (blinkoraItem.type === NoteType.NOTE) {
      return (
        <>
          {t('note')}
          {blinkoraItem.isBlog ? ` · ${t('article')}` : ''}
          {blinkoraItem.isArchived ? ` · ${t('archived')}` : ''}
          {blinkoraItem.isOffline ? ` · ${t('offline')}` : ''}
        </>
      );
    }

    return (
      <>
        {t('blinkora')}
        {blinkoraItem.isBlog ? ` · ${t('article')}` : ''}
        {blinkoraItem.isArchived ? ` · ${t('archived')}` : ''}
        {blinkoraItem.isOffline ? ` · ${t('offline')}` : ''}
      </>
    );
  };

  const getTooltipContent = () => {
    if (blinkoraItem.type !== NoteType.TODO) {
      return tooltip;
    }

    const todoStatus = getTodoStatus();
    if (!blinkoraItem.metadata?.expireAt) {
      return tooltip;
    }
    const expireDate = dayjs(blinkoraItem.metadata.expireAt);
    if (todoStatus.status === 'expired') {
      return tooltip ?? `${t('expired')}: ${expireDate.format('YYYY-MM-DD HH:mm')}`;
    }
    return tooltip ?? `${t('expiry-time')}: ${expireDate.format('YYYY-MM-DD HH:mm')}`;
  };

  const getTimeDisplay = () => {
    if (!blinkoraItem.metadata?.expireAt) {
      return null;
    }

    const todoStatus = getTodoStatus();
    const expireDate = dayjs(blinkoraItem.metadata.expireAt);
    const now = dayjs();

    if (todoStatus.status === 'expired') {
      const diffInMinutes = now.diff(expireDate, 'minute');
      const diffInHours = now.diff(expireDate, 'hour');
      const diffInDays = now.diff(expireDate, 'day');

      if (diffInDays > 0) {
        return t('expired-days', { count: diffInDays });
      } else if (diffInHours > 0) {
        return t('expired-hours', { count: diffInHours });
      } else if (diffInMinutes > 0) {
        return t('expired-minutes', { count: diffInMinutes });
      } else {
        return t('just-expired');
      }
    }

    const diffInMinutes = expireDate.diff(now, 'minute');
    const diffInHours = expireDate.diff(now, 'hour');
    const diffInDays = expireDate.diff(now, 'day');

    if (diffInDays > 0) {
      return t('days-left', { count: diffInDays });
    } else if (diffInHours > 0) {
      return t('hours-left', { count: diffInHours });
    } else if (diffInMinutes > 0) {
      return t('minutes-left', { count: diffInMinutes });
    } else {
      return t('about-to-expire');
    }
  };

  const currentOption = getNoteTypeOption(blinkoraItem.type);
  const triggerIconClassName = blinkoraItem.type === NoteType.TODO
    ? getTodoStatus().color
    : currentOption.iconClassName;
  const resolvedTooltip = getTooltipContent();

  return (
    <NoteTypePicker
      value={blinkoraItem.type}
      onChange={handleTypeChange}
      tooltip={resolvedTooltip}
      tooltipPlacement={tooltipPlacement}
      toolTipClassNames={toolTipClassNames}
      trigger={(option) => (
        <button
          type="button"
          data-drag-ignore="true"
          className="flex items-center justify-start cursor-pointer"
        >
          <Icon className={triggerIconClassName} icon={option.icon} width="12" height="12" />
          <div className="text-desc text-xs font-bold ml-1 select-none">
            {renderStatusText()}
          </div>
        </button>
      )}
    />
  );
};

const RightContent = ({ blinkoraItem }: { blinkoraItem: Note }) => {
  return (
    <div data-drag-ignore="true" className="ml-auto flex items-center gap-2">
      <AnnotationCountBadge blinkoraItem={blinkoraItem} />
      {blinkoraItem?.metadata?.isIndexed && (
        <Tooltip content={'Indexed'} delay={1500}>
          <Icon className="!text-ignore opacity-50" icon="hugeicons:ai-beautify" width="16" height="16" />
        </Tooltip>
      )}
    </div>
  );
};
