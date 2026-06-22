import dayjs from '@/lib/dayjs';
import { stringifyNotePropertyValueInput } from '@/lib/noteProperties';
import { Icon } from '@/components/Common/Iconify/icons';
import { Note, NoteType } from '@shared/lib/types';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { BlinkoraStore } from '@/store/blinkoraStore';

type CardBackProps = {
  blinkoraItem: Note;
  blinkora: BlinkoraStore;
  isExpanded?: boolean;
  onTopPointerDown: React.PointerEventHandler<HTMLDivElement>;
  onTopPointerMove: React.PointerEventHandler<HTMLDivElement>;
  onTopPointerUp: React.PointerEventHandler<HTMLDivElement>;
  onTopClick: React.MouseEventHandler<HTMLDivElement>;
};

type InfoItem = {
  label: string;
  value: React.ReactNode;
};

const typeIconMap: Record<number, { icon: string; className: string; labelKey: string }> = {
  [NoteType.BLINKORA]: {
    icon: 'basil:lightning-solid',
    className: 'text-yellow-500',
    labelKey: 'blinkora',
  },
  [NoteType.NOTE]: {
    icon: 'solar:notes-minimalistic-bold-duotone',
    className: 'text-blue-500',
    labelKey: 'note',
  },
  [NoteType.TODO]: {
    icon: 'solar:folder-check-bold',
    className: 'text-green-500',
    labelKey: 'todo',
  },
};

const normalizeTagName = (tagItem: any) => {
  const tag = tagItem?.tag ?? tagItem;
  return tag?.name;
};

const getTagPaths = (tags: Note['tags']) => {
  const normalizedTags = tags?.map(normalizeTagName).filter(Boolean) ?? [];
  return Array.from(new Set(normalizedTags)).sort((a, b) => a.localeCompare(b));
};

const formatTime = (value: Note['createdAt'], timeFormat?: string) => {
  if (!value) return '-';
  return dayjs(value).format(timeFormat && timeFormat !== 'relative' ? timeFormat : 'YYYY-MM-DD HH:mm:ss');
};

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rounded-lg border border-default-200/80 bg-default-50/60 p-3 dark:border-default-100/20 dark:bg-default-100/10">
    <div className="mb-2 text-xs font-semibold text-default-500">{title}</div>
    {children}
  </div>
);

const InfoGrid = ({ items }: { items: InfoItem[] }) => (
  <div className="grid grid-cols-2 gap-2">
    {items.map(item => (
      <div key={item.label} className="min-w-0 rounded-md bg-background/70 px-2.5 py-2 dark:bg-default-50/5">
        <div className="text-[11px] leading-4 text-default-400">{item.label}</div>
        <div className="mt-0.5 truncate text-xs font-medium text-default-700 dark:text-default-300">
          {item.value}
        </div>
      </div>
    ))}
  </div>
);

const CountPill = ({ label, count }: { label: string; count: number }) => (
  <div className="flex items-center justify-between rounded-md bg-background/70 px-2.5 py-2 dark:bg-default-50/5">
    <span className="text-xs text-default-500">{label}</span>
    <span className="text-sm font-semibold text-default-700 dark:text-default-300">{count}</span>
  </div>
);

export const CardBack = ({
  blinkoraItem,
  blinkora,
  isExpanded,
  onTopPointerDown,
  onTopPointerMove,
  onTopPointerUp,
  onTopClick,
}: CardBackProps) => {
  const { t } = useTranslation();
  const typeOption = typeIconMap[blinkoraItem.type ?? NoteType.BLINKORA] ?? typeIconMap[NoteType.BLINKORA];
  const timeFormat = blinkora.config.value?.timeFormat;
  const tags = getTagPaths(blinkoraItem.tags);
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
  ].filter(Boolean);
  const referencesCount = blinkoraItem.references?.length ?? 0;
  const referencedByCount = blinkoraItem.referencedBy?.length ?? 0;
  const commentsCount = (blinkoraItem as any)._count?.comments ?? blinkoraItem.comments?.length ?? 0;

  return (
    <div className={`w-full ${isExpanded ? 'min-h-[220px]' : ''}`}>
      <div
        className={`mb-3 flex min-h-8 cursor-pointer items-center gap-2 ${isExpanded ? 'text-base' : 'text-sm'}`}
        onPointerDown={onTopPointerDown}
        onPointerMove={onTopPointerMove}
        onPointerUp={onTopPointerUp}
        onClick={onTopClick}
        title={t('flip-to-front')}
      >
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-default-100 text-default-600 dark:bg-default-100/20 dark:text-default-300">
          <Icon icon="ri:exchange-2-line" width={15} height={15} />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-semibold text-foreground">{t('card-back')}</span>
          <span className="text-xs text-default-400">{t('properties')}</span>
        </div>
        <Icon className="ml-auto text-default-400" icon="ri:corner-up-left-line" width={17} height={17} />
      </div>

      <div className="flex flex-col gap-3">
        <Section title={t('card-status')}>
          <div className="flex flex-wrap gap-1.5">
            <div className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
              <Icon className={typeOption.className} icon={typeOption.icon} width={13} height={13} />
              {t(typeOption.labelKey)}
            </div>
            {statusItems.length > 0 ? statusItems.map(item => (
              <span key={String(item)} className="rounded-full bg-default-100 px-2.5 py-1 text-xs text-default-600 dark:bg-default-100/20 dark:text-default-300">
                {item}
              </span>
            )) : (
              <span className="rounded-full bg-default-100 px-2.5 py-1 text-xs text-default-500 dark:bg-default-100/20">
                -
              </span>
            )}
          </div>
        </Section>

        <Section title={t('card-relations')}>
          <div className="grid grid-cols-2 gap-2">
            <CountPill label={t('attachment')} count={blinkoraItem.attachments?.length ?? 0} />
            <CountPill label={t('comment')} count={commentsCount} />
            <CountPill label={t('reference')} count={referencesCount} />
            <CountPill label={t('reference-by')} count={referencedByCount} />
          </div>
          {tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tags.map(tag => (
                <span key={tag} className="blinkora-tag rounded px-1.5 py-0.5 text-xs font-semibold text-default-700 dark:text-default-200">
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </Section>

        <Section title={t('card-time')}>
          <InfoGrid items={[
            { label: t('created-time'), value: formatTime(blinkoraItem.createdAt, timeFormat) },
            { label: t('updated-time'), value: formatTime(blinkoraItem.updatedAt, timeFormat) },
          ]} />
        </Section>

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
