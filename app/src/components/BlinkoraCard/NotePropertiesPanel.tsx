import { Button, Textarea } from '@heroui/react';
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
  parseNotePropertiesYaml,
  stringifyNotePropertiesYaml,
} from '@/lib/noteProperties';
import { BlinkoraItem } from './index';

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

  const propertiesYaml = useMemo(
    () => stringifyNotePropertiesYaml(blinkoraItem.metadata?.properties),
    [blinkoraItem.metadata?.properties],
  );
  const [draft, setDraft] = useState(propertiesYaml);
  const hasProperties = hasNoteProperties(blinkoraItem.metadata?.properties);

  useEffect(() => {
    if (!isEditing) {
      setDraft(propertiesYaml);
      setError('');
    }
  }, [isEditing, propertiesYaml]);

  const handleSave = async () => {
    if (!blinkoraItem.id) return;

    const result = parseNotePropertiesYaml(draft);
    if (!result.ok) {
      setError(t('invalid-properties-yaml', { reason: result.error }));
      return;
    }

    const nextMetadata = { ...(blinkoraItem.metadata ?? {}) };
    if (Object.keys(result.properties).length === 0) {
      delete nextMetadata.properties;
    } else {
      nextMetadata.properties = result.properties;
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
      setDraft(stringifyNotePropertiesYaml(nextMetadata.properties));
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
              <Textarea
                value={draft}
                onValueChange={(value) => {
                  setDraft(value);
                  setError('');
                }}
                minRows={5}
                maxRows={12}
                variant="bordered"
                classNames={{
                  input: 'font-mono text-xs leading-5',
                }}
                placeholder={'type: permanent\nstatus: 待整理\ntags:\n  - 自媒体'}
              />
              {error && <div className="text-xs text-danger">{error}</div>}
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="light"
                  onPress={() => {
                    setDraft(propertiesYaml);
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
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-background/70 p-3 font-mono text-xs leading-5 text-default-700">
                  {propertiesYaml}
                </pre>
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
                    setDraft(propertiesYaml);
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
