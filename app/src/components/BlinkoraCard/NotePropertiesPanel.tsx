import { Button } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@heroui/theme';
import { Icon } from '@/components/Common/Iconify/icons';
import { RootStore } from '@/store';
import { BlinkoraStore } from '@/store/blinkoraStore';
import { ToastPlugin } from '@/store/module/Toast/Toast';
import {
  hasNoteProperties,
  NoteProperties,
  parseNotePropertyValueInput,
  stringifyNotePropertyValueInput,
} from '@/lib/noteProperties';
import { BlinkoraItem } from './index';
import { PropertyValue } from './PropertyValue';

type PropertyRow = {
  id: string;
  key: string;
  value: string;
};

let propertyRowId = 0;

const createPropertyRow = (key = '', value = ''): PropertyRow => ({
  id: `property-row-${propertyRowId++}`,
  key,
  value,
});

const rowsFromProperties = (properties: unknown): PropertyRow[] => {
  if (!hasNoteProperties(properties)) return [createPropertyRow()];

  return Object.keys(properties)
    .sort((a, b) => a.localeCompare(b))
    .map(key => createPropertyRow(
      key,
      stringifyNotePropertyValueInput((properties as NoteProperties)[key]),
    ));
};

export const NotePropertiesPanel = observer(({
  blinkoraItem,
  className,
}: {
  blinkoraItem: BlinkoraItem;
  className?: string;
}) => {
  const { t } = useTranslation();
  const blinkora = RootStore.Get(BlinkoraStore);
  const [isOpen, setIsOpen] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  const propertyRows = useMemo(
    () => rowsFromProperties(blinkoraItem.metadata?.properties),
    [blinkoraItem.metadata?.properties],
  );
  const [draftRows, setDraftRows] = useState<PropertyRow[]>(propertyRows);
  const hasProperties = hasNoteProperties(blinkoraItem.metadata?.properties);

  useEffect(() => {
    if (!isEditing) {
      setDraftRows(propertyRows);
      setError('');
    }
  }, [isEditing, propertyRows]);

  const updateDraftRow = (id: string, field: 'key' | 'value', value: string) => {
    setDraftRows(rows => rows.map(row => (
      row.id === id ? { ...row, [field]: value } : row
    )));
    setError('');
  };

  const handleValueFocus = (index: number) => {
    setDraftRows(rows => (
      index === rows.length - 1 ? [...rows, createPropertyRow()] : rows
    ));
  };

  const handleSave = async () => {
    if (!blinkoraItem.id) return;

    const properties: NoteProperties = {};
    const seenKeys = new Set<string>();

    for (const row of draftRows) {
      const key = row.key.trim();
      const value = row.value.trim();
      if (!key && !value) continue;
      if (!key) {
        setError(t('property-key-required'));
        return;
      }
      if (seenKeys.has(key)) {
        setError(t('duplicate-property-key', { key }));
        return;
      }

      const parsedValue = parseNotePropertyValueInput(row.value);
      if (!parsedValue.ok) {
        setError(t('invalid-property-value', {
          key,
          reason: t(parsedValue.error, { defaultValue: parsedValue.error }),
        }));
        return;
      }

      seenKeys.add(key);
      properties[key] = parsedValue.value;
    }

    const nextMetadata = { ...(blinkoraItem.metadata ?? {}) };
    if (Object.keys(properties).length === 0) {
      delete nextMetadata.properties;
    } else {
      nextMetadata.properties = properties;
    }

    setIsSaving(true);
    try {
      await blinkora.upsertNote.call({
        id: blinkoraItem.id,
        metadata: nextMetadata,
        refresh: false,
        showToast: false,
      });
      blinkoraItem.metadata = nextMetadata;
      if (blinkora.noteDetail.value?.id === blinkoraItem.id) {
        blinkora.noteDetail.value.metadata = nextMetadata;
      }
      if (blinkora.curSelectedNote?.id === blinkoraItem.id) {
        blinkora.curSelectedNote.metadata = nextMetadata;
      }
      setDraftRows(rowsFromProperties(nextMetadata.properties));
      setError('');
      setIsEditing(false);
      RootStore.Get(ToastPlugin).success(t('properties-saved'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className={cn('border-t border-border pt-4', className)}>
      <button
        type="button"
        className="flex w-full items-center justify-between rounded-md px-1 py-2 text-left text-default-700 transition-colors hover:text-foreground"
        onClick={() => setIsOpen(value => !value)}
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <Icon icon="tabler:database" width={17} height={17} />
          {t('properties')}
        </span>
        <Icon icon={isOpen ? 'tabler:chevron-up' : 'tabler:chevron-down'} width={18} height={18} />
      </button>

      {isOpen && (
        <div className="mt-2 rounded-md border border-border bg-default-50/70 p-3 dark:bg-default-100/10">
          {isEditing ? (
            <div className="flex flex-col gap-3">
              <div className="text-xs leading-5 text-default-500">
                {t('properties-table-tip')}
              </div>
              <div className="overflow-hidden rounded-lg border border-default-300 bg-background/80 dark:border-default-200/40 dark:bg-default-50/5">
                <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] border-b border-default-300 bg-default-100/70 text-sm font-semibold text-default-600 dark:border-default-200/40 dark:bg-default-100/10 dark:text-default-400">
                  <div className="border-r border-default-300 px-3 py-2 dark:border-default-200/40">
                    {t('property-key')}
                  </div>
                  <div className="px-3 py-2">
                    {t('property-value')}
                  </div>
                </div>
                {draftRows.map((row, index) => (
                  <div
                    key={row.id}
                    className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] border-b border-default-200 last:border-b-0 dark:border-default-200/25"
                  >
                    <input
                      value={row.key}
                      aria-label={t('property-key')}
                      className="min-h-11 min-w-0 border-r border-default-200 bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-default-400 focus:bg-default-100/60 dark:border-default-200/25 dark:focus:bg-default-100/10"
                      placeholder={t('property-key-placeholder')}
                      onChange={event => updateDraftRow(row.id, 'key', event.target.value)}
                    />
                    <input
                      value={row.value}
                      aria-label={t('property-value')}
                      className="min-h-11 min-w-0 bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-default-400 focus:bg-default-100/60 dark:focus:bg-default-100/10"
                      placeholder={t('property-value-placeholder')}
                      onFocus={() => handleValueFocus(index)}
                      onChange={event => updateDraftRow(row.id, 'value', event.target.value)}
                    />
                  </div>
                ))}
              </div>
              {error && <div className="text-xs text-danger">{error}</div>}
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="light"
                  onPress={() => {
                    setDraftRows(propertyRows);
                    setError('');
                    setIsEditing(false);
                  }}
                >
                  {t('cancel')}
                </Button>
                <Button
                  size="sm"
                  color="primary"
                  isLoading={isSaving}
                  onPress={handleSave}
                >
                  {t('save-properties')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {hasProperties ? (
                <div className="overflow-hidden rounded-lg border border-default-200 bg-background/70 dark:border-default-200/30">
                  {propertyRows.map(row => (
                    <div
                      key={row.id}
                      className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] border-b border-default-200 text-sm last:border-b-0 dark:border-default-200/25"
                    >
                      <div className="min-w-0 border-r border-default-200 px-3 py-2 font-medium text-default-600 dark:border-default-200/25">
                        {row.key}
                      </div>
                      <div className="min-w-0 break-words px-3 py-2 text-default-700 dark:text-default-300">
                        <PropertyValue value={row.value} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded bg-background/70 p-3 text-xs text-default-500">
                  {t('no-properties')}
                </div>
              )}
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="flat"
                  onPress={() => {
                    setDraftRows(propertyRows);
                    setError('');
                    setIsEditing(true);
                  }}
                >
                  {t('edit-properties')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
});
