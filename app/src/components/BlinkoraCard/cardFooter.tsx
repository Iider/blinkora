import { Icon } from '@/components/Common/Iconify/icons';
import { Tooltip } from '@heroui/react';
import { Note, NoteType } from '@shared/lib/types';
import { ConvertItemFunction, ShowEditTimeModel } from '../BlinkoraRightClickMenu';
import { BlinkoraStore } from '@/store/blinkoraStore';
import { useTranslation } from 'react-i18next';
import { _ } from '@/lib/lodash';
import { BlinkoraItem } from '.';
import { RootStore } from '@/store';
import dayjs from '@/lib/dayjs';
import { AnnotationCountBadge } from './annotationButton';

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

  const handleClick = (e) => {
    e.stopPropagation();
    blinkora.curSelectedNote = _.cloneDeep(blinkoraItem);
    
    if (blinkoraItem.type === NoteType.TODO) {
      ShowEditTimeModel(true);
    } else {
      ConvertItemFunction();
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

  if (blinkoraItem.type === NoteType.BLINKORA) {
    return (
      <Tooltip placement={tooltipPlacement} classNames={toolTipClassNames} content={tooltip ?? t('convert-to') + ' Note'} delay={1000}>
        <div data-drag-ignore="true" className="flex items-center justify-start cursor-pointer" onClick={handleClick}>
          <Icon className="text-yellow-500" icon="basil:lightning-solid" width="12" height="12" />
          <div className="text-desc text-xs font-bold ml-1 select-none">
            {t('blinkora')}
            {blinkoraItem.isBlog ? ` · ${t('article')}` : ''}
            {blinkoraItem.isArchived ? ` · ${t('archived')}` : ''}
            {blinkoraItem.isOffline ? ` · ${t('offline')}` : ''}
          </div>
        </div>
      </Tooltip>
    );
  }

  if (blinkoraItem.type === NoteType.TODO) {
    const todoStatus = getTodoStatus();
    const getTooltipContent = () => {
      if (!blinkoraItem.metadata?.expireAt) {
        return t('set-deadline');
      }
      const expireDate = dayjs(blinkoraItem.metadata.expireAt);
      if (todoStatus.status === 'expired') {
        return `${t('expired')}: ${expireDate.format('YYYY-MM-DD HH:mm')}`;
      }
      return `${t('expiry-time')}: ${expireDate.format('YYYY-MM-DD HH:mm')}`;
    };

    const getTimeDisplay = () => {
      if (!blinkoraItem.metadata?.expireAt) {
        return null;
      }
      
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
      } else {
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
      }
    };

    return (
      <Tooltip placement={tooltipPlacement} classNames={toolTipClassNames} content={tooltip ?? getTooltipContent()} delay={1000}>
        <div data-drag-ignore="true" className="flex items-center justify-start cursor-pointer" onClick={handleClick}>
          <Icon className={todoStatus.color} icon="solar:folder-check-bold" width="12" height="12" />
          <div className="text-desc text-xs font-bold ml-1 select-none">
            {t('todo')}
            {blinkoraItem.metadata?.expireAt && (
              <span className={todoStatus.color}>
                {' · '}{getTimeDisplay()}
              </span>
            )}
            {blinkoraItem.isBlog ? ` · ${t('article')}` : ''}
            {blinkoraItem.isArchived ? ` · ${t('archived')}` : ''}
            {blinkoraItem.isOffline ? ` · ${t('offline')}` : ''}
          </div>
        </div>
      </Tooltip>
    );
  }

  return (
    <Tooltip content={t('convert-to') + ' Blinkora'} delay={1500}>
      <div data-drag-ignore="true" className="flex items-center justify-start cursor-pointer" onClick={handleClick}>
        <Icon className="text-blue-500" icon="solar:notes-minimalistic-bold-duotone" width="12" height="12" />
        <div className="text-desc text-xs font-bold ml-1 select-none">
          {t('note')}
          {blinkoraItem.isBlog ? ` · ${t('article')}` : ''}
          {blinkoraItem.isArchived ? ` · ${t('archived')}` : ''}
          {blinkoraItem.isOffline ? ` · ${t('offline')}` : ''}
        </div>
      </div>
    </Tooltip>
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
