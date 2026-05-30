import { Button } from '@heroui/react';
import { api } from '@/lib/trpc';
import { RootStore } from '@/store';
import { BlinkoraStore } from '@/store/blinkoraStore';
import { DialogStandaloneStore } from '@/store/module/DialogStandalone';
import { ToastPlugin } from '@/store/module/Toast/Toast';
import { showTipsDialog } from '@/components/Common/TipsDialog';
import i18n from '@/lib/i18n';

type DeleteNoteOptions = {
  ids: number[];
  onDeleted?: () => void;
};

export const confirmDeleteNotes = async ({ ids, onDeleted }: DeleteNoteOptions) => {
  const noteIds = ids.filter((id): id is number => typeof id === 'number');
  if (!noteIds.length) return;

  const impact = await api.notes.deleteImpact.mutate({ ids: noteIds });
  const orphanAttachments = impact.orphanAttachments ?? [];

  const runDelete = async (deleteOrphanAttachments: boolean) => {
    await RootStore.Get(ToastPlugin).promise(
      api.notes.deleteMany.mutate({ ids: noteIds, deleteOrphanAttachments }),
      {
        loading: i18n.t('in-progress'),
        success: <b>{i18n.t('your-changes-have-been-saved')}</b>,
        error: (error: any) => <b>{error?.message || i18n.t('operation-failed')}</b>,
      }
    );
    RootStore.Get(DialogStandaloneStore).close();
    RootStore.Get(BlinkoraStore).updateTicker++;
    onDeleted?.();
  };

  if (!orphanAttachments.length) {
    showTipsDialog({
      title: i18n.t('confirm-to-delete'),
      content: i18n.t('permanent-delete-note-confirm'),
      onConfirm: () => runDelete(false),
    });
    return;
  }

  showTipsDialog({
    title: i18n.t('confirm-to-delete'),
    content: (
      <div className="flex flex-col gap-3">
        <div>{i18n.t('permanent-delete-note-with-unused-resources-warning')}</div>
        <div className="max-h-32 overflow-y-auto rounded-lg bg-secondbackground p-2 text-xs text-desc">
          {orphanAttachments.map((attachment: any) => (
            <div key={attachment.id} className="truncate">
              {attachment.name || attachment.path}
            </div>
          ))}
        </div>
      </div>
    ),
    buttonSlot: (
      <div className="ml-auto flex flex-wrap justify-end gap-2">
        <Button color="default" onPress={() => RootStore.Get(DialogStandaloneStore).close()}>
          {i18n.t('cancel')}
        </Button>
        <Button color="warning" variant="flat" onPress={() => runDelete(false)}>
          {i18n.t('delete-note-only')}
        </Button>
        <Button color="danger" onPress={() => runDelete(true)}>
          {i18n.t('delete-note-and-unused-resources')}
        </Button>
      </div>
    ),
  });
};
