import dayjs from '@/lib/dayjs';
import { stringifyNotePropertyValueInput } from '@/lib/noteProperties';
import { Icon } from '@/components/Common/Iconify/icons';
import { getNoteTypeOption } from '@/components/Common/NoteTypePicker';
import { _ } from '@/lib/lodash';
import { Note } from '@shared/lib/types';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { BlinkoraStore } from '@/store/blinkoraStore';
import { LeftCickMenu } from '../BlinkoraRightClickMenu';

type CardBackProps = {
  blinkoraItem: Note;
  blinkora: BlinkoraStore;
  isExpanded?: boolean;
};

const formatTime = (value: Note['createdAt'], timeFormat?: string) => {
  if (!value) return '-';
  return dayjs(value).format(timeFormat && timeFormat !== 'relative' ? timeFormat.replace(/:ss\b/, '') : 'YYYY-MM-DD HH:mm');
};

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rounded-lg border border-default-200/80 bg-default-50/60 p-3 dark:border-default-100/20 dark:bg-default-100/10">
    <div className="mb-2 text-xs font-semibold text-default-500">{title}</div>
    {children}
  </div>
);

export const CardBack = ({
  blinkoraItem,
  blinkora,
  isExpanded,
}: CardBackProps) => {
  const { t } = useTranslation();
  const typeOption = getNoteTypeOption(blinkoraItem.type);
  const timeFormat = blinkora.config.value?.timeFormat;
  const isFrontUsingCreateTime = !!blinkora.config.value?.isOrderByCreateTime;
  const headerTime = formatTime(
    isFrontUsingCreateTime ? blinkoraItem.updatedAt : blinkoraItem.createdAt,
    timeFormat,
  );
  const customProperties = blinkoraItem.metadata?.properties;
  const propertyRows = customProperties && typeof customProperties === 'object'
    ? Object.keys(customProperties).sort((a, b) => a.localeCompare(b)).map(key => ({
      key,
      value: stringifyNotePropertyValueInput(customProperties[key]),
    }))
    : [];
  const statusItems = [
    blinkoraItem.isTop ? t('top') : null,
    blinkoraItem.isArchived ? t('archived') : null,
    blinkoraItem.isRecycle ? t('trash') : null,
    blinkoraItem.isReviewed ? t('reviewed') : null,
    blinkoraItem.isOffline ? t('offline') : null,
    blinkoraItem.metadata?.expireAt ? `${t('expiry-time')}: ${formatTime(blinkoraItem.metadata.expireAt, timeFormat)}` : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <div className={`w-full ${isExpanded ? 'min-h-[220px]' : ''}`}>
      <div
        className={`mb-3 flex min-h-8 cursor-pointer items-center gap-1.5 ${isExpanded ? 'text-base' : 'text-sm'}`}
        title={t('flip-to-front')}
      >
        <Icon className={`${typeOption.iconClassName} shrink-0`} icon={typeOption.icon} width={16} height={16} />
        <div className="min-w-0 truncate text-sm font-bold text-desc">{t(typeOption.labelKey)}</div>
        <div className="ml-auto whitespace-nowrap text-xs text-default-400">{headerTime}</div>
        <LeftCickMenu
          className="ml-1 shrink-0"
          onTrigger={() => { blinkora.curSelectedNote = _.cloneDeep(blinkoraItem); }}
        />
      </div>

      <div className="flex flex-col gap-3">
        {statusItems.length > 0 && (
          <Section title={t('card-status')}>
            <div className="flex flex-wrap gap-1.5">
              {statusItems.map(item => (
                <span key={item} className="rounded-full bg-default-100 px-2.5 py-1 text-xs text-default-600 dark:bg-default-100/20 dark:text-default-300">
                  {item}
                </span>
              ))}
            </div>
          </Section>
        )}

        <Section title={t('properties')}>
          {propertyRows.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-default-200 bg-background/70 dark:border-default-100/20 dark:bg-default-50/5">
              {propertyRows.map(row => (
                <div
                  key={row.key}
                  className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] border-b border-default-200 text-xs last:border-b-0 dark:border-default-100/20"
                >
                  <div className="min-w-0 truncate border-r border-default-200 px-2.5 py-2 font-medium text-default-500 dark:border-default-100/20">
                    {row.key}
                  </div>
                  <div className="min-w-0 break-words px-2.5 py-2 text-default-700 dark:text-default-300">
                    {row.value}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-md bg-background/70 px-2.5 py-2 text-xs text-default-400 dark:bg-default-50/5">
              {t('no-properties')}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
};
