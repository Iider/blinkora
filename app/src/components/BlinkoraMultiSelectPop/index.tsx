import { observer } from 'mobx-react-lite';
import { RootStore } from '@/store';
import { useTranslation } from 'react-i18next';
import { ToastPlugin } from '@/store/module/Toast/Toast';
import { ShowUpdateTagDialog } from '../Common/UpdateTagPop';
import { BlinkoraStore } from '@/store/blinkoraStore';
import { api } from '@/lib/trpc';
import { MultiSelectToolbar } from '../Common/MultiSelectToolbar';
import { confirmDeleteNotes } from '@/lib/noteDeletion';
import { useSearchParams } from 'react-router-dom';

export const BlinkoraMultiSelectPop = observer(() => {
  const { t } = useTranslation();
  const blinkora = RootStore.Get(BlinkoraStore);
  const [searchParams] = useSearchParams();
  const isArchivedView = blinkora.noteListFilterConfig.isArchived;
  const isRecycleView = searchParams.get('path') === 'trash';

  const resetMultiSelectAfterMutation = () => {
    blinkora.onMultiSelectRest();
  };

  const actions = [
    {
      icon: isArchivedView ? "eva:archive-outline" : "eva:archive-outline",
      text: isArchivedView ? t('recovery') : t('archive'),
      onClick: async () => {
        await RootStore.Get(ToastPlugin).promise(
          api.notes.updateMany.mutate({ ids: blinkora.curMultiSelectIds, isArchived: !isArchivedView }),
          {
            loading: t('in-progress'),
            success: <b>{t('your-changes-have-been-saved')}</b>,
            error: <b>{t('operation-failed')}</b>,
          });
        blinkora.onMultiSelectRest();
      }
    },
    {
      icon: "solar:tag-outline",
      text: t('add-tag'),
      onClick: () => {
        ShowUpdateTagDialog({
          type: 'select',
          onSave: async (tagName) => {
            await RootStore.Get(ToastPlugin).promise(
              api.tags.updateTagMany.mutate({ tag: tagName, ids: blinkora.curMultiSelectIds }),
              {
                loading: t('in-progress'),
                success: <b>{t('your-changes-have-been-saved')}</b>,
                error: <b>{t('operation-failed')}</b>,
              });
            blinkora.onMultiSelectRest();
          }
        });
      }
    },
    {
      icon: "mingcute:delete-2-line",
      text: isRecycleView ? t('delete') : t('trash'),
      isDeleteButton: true,
      onClick: async () => {
        const ids = [...blinkora.curMultiSelectIds];
        if (ids.length === 0) return;

        if (isRecycleView) {
          confirmDeleteNotes({ ids, onDeleted: resetMultiSelectAfterMutation });
          return;
        }

        await RootStore.Get(ToastPlugin).promise(
          api.notes.trashMany.mutate({ ids }),
          {
            loading: t('in-progress'),
            success: <b>{t('your-changes-have-been-saved')}</b>,
            error: <b>{t('operation-failed')}</b>,
          }
        );
        resetMultiSelectAfterMutation();
        blinkora.updateTicker++;
      }
    }
  ];

  return (
    <MultiSelectToolbar
      show={blinkora.isMultiSelectMode}
      actions={actions}
      onClose={() => blinkora.onMultiSelectRest()}
    />
  );
});
