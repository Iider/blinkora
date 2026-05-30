import { observer } from "mobx-react-lite";
import { BlinkoraStore } from '@/store/blinkoraStore';
import { Dropdown, DropdownTrigger, DropdownMenu, DropdownItem, Button, DatePicker } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { ContextMenu, ContextMenuItem } from '@/components/Common/ContextMenu';
import { Icon } from '@/components/Common/Iconify/icons';
import { PromiseCall } from '@/store/standard/PromiseState';
import { api } from '@/lib/trpc';
import { RootStore } from "@/store";
import { DialogStore } from "@/store/module/Dialog";
import { BlinkoraEditor } from "../BlinkoraEditor";
import { useEffect, useState } from "react";
import { NoteType } from "@shared/lib/types";
import { parseAbsoluteToLocal } from "@internationalized/date";
import i18n from "@/lib/i18n";
import { useLocation } from "react-router-dom";
import { FocusEditorFixMobile } from "@/components/Common/Editor/editorUtils";
import { confirmDeleteNotes } from "@/lib/noteDeletion";


export const ShowEditTimeModel = (showExpired: boolean = false) => {
  const blinkora = RootStore.Get(BlinkoraStore)
  RootStore.Get(DialogStore).setData({
    size: 'sm' as any,
    isOpen: true,
    onlyContent: true,
    isDismissable: false,
    showOnlyContentCloseButton: true,
    content: () => {
      const [createdAt, setCreatedAt] = useState(blinkora.curSelectedNote?.createdAt ?
        parseAbsoluteToLocal(blinkora.curSelectedNote.createdAt.toISOString()) : null);

      const [updatedAt, setUpdatedAt] = useState(blinkora.curSelectedNote?.updatedAt ?
        parseAbsoluteToLocal(blinkora.curSelectedNote.updatedAt.toISOString()) : null);

      const [expireAt, setExpireAt] = useState(blinkora.curSelectedNote?.metadata?.expireAt ?
        parseAbsoluteToLocal(new Date(blinkora.curSelectedNote.metadata.expireAt).toISOString()) : null);

      const handleSave = () => {
        if (showExpired) {
          // Handle expired date save
          const existingMetadata = blinkora.curSelectedNote?.metadata || {};
          
          blinkora.upsertNote.call({
            id: blinkora.curSelectedNote?.id,
            metadata: {
              ...existingMetadata,
              expireAt: expireAt ? expireAt.toDate().toISOString() : null
            }
          });
        } else {
          // Handle created/updated date save
          if (!createdAt || !updatedAt) return;

          blinkora.upsertNote.call({
            id: blinkora.curSelectedNote?.id,
            createdAt: createdAt.toDate(),
            updatedAt: updatedAt.toDate()
          });
        }

        RootStore.Get(DialogStore).close();
      }

      return <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 p-4">
          {showExpired ? (
            // Show expired date picker for TODO
            <>
              <DatePicker
                label={i18n.t('expiry-time')}
                value={expireAt}
                onChange={setExpireAt}
                labelPlacement="outside"
                showMonthAndYearPickers
                granularity="second"
                hideTimeZone
              />
              
              {/* Quick time selection buttons */}
              <div className="flex flex-col gap-2">
                <div className="text-sm text-gray-600 font-medium">{i18n.t('quick-select') || 'Quick Select'}:</div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="bordered"
                    onPress={() => {
                      const now = new Date();
                      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                      setExpireAt(parseAbsoluteToLocal(tomorrow.toISOString()));
                    }}
                  >
                    {i18n.t('1-day') || '1 Day'}
                  </Button>
                  <Button
                    size="sm"
                    variant="bordered"
                    onPress={() => {
                      const now = new Date();
                      const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
                      setExpireAt(parseAbsoluteToLocal(nextWeek.toISOString()));
                    }}
                  >
                    {i18n.t('1-week') || '1 Week'}
                  </Button>
                  <Button
                    size="sm"
                    variant="bordered"
                    onPress={() => {
                      const now = new Date();
                      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds());
                      setExpireAt(parseAbsoluteToLocal(nextMonth.toISOString()));
                    }}
                  >
                    {i18n.t('1-month') || '1 Month'}
                  </Button>
                  <Button
                    size="sm"
                    variant="bordered"
                    color="warning"
                    onPress={() => {
                      setExpireAt(null);
                    }}
                  >
                    {i18n.t('cancel')}
                  </Button>
                </div>
              </div>

              <div className="flex gap-2">
                <Button
                  color="primary"
                  className="flex-1"
                  onPress={handleSave}
                >
                  {i18n.t('save')}
                </Button>
              </div>
            </>
          ) : (
            // Show created/updated date pickers
            <>
              <DatePicker
                label={i18n.t('created-at')}
                value={createdAt}
                onChange={setCreatedAt}
                labelPlacement="outside"
                granularity="second"
                hideTimeZone
              />
              <DatePicker
                label={i18n.t('updated-at')}
                value={updatedAt}
                onChange={setUpdatedAt}
                labelPlacement="outside"
                granularity="second"
                hideTimeZone
              />
              <Button
                color="primary"
                className="mt-2"
                onPress={handleSave}
              >
                {i18n.t('save')}
              </Button>
            </>
          )}
        </div>
      </div>
    }
  })
}

export const ShowEditBlinkoraModel = (size: string = '2xl', mode: 'create' | 'edit' = 'edit', initialData?: { file?: File, text?: string }) => {
  const blinkora = RootStore.Get(BlinkoraStore)
  RootStore.Get(DialogStore).setData({
    size: size as any,
    isOpen: true,
    onlyContent: true,
    isDismissable: false,
    showOnlyContentCloseButton: true,
    content: <BlinkoraEditor isInDialog mode={mode} initialData={initialData} key={`editor-key-${mode}`} onSended={() => {
      RootStore.Get(DialogStore).close()
      blinkora.isCreateMode = false
    }} />
  })
}

const handleEdit = (isDetailPage: boolean) => {
  ShowEditBlinkoraModel(isDetailPage ? '5xl' : '5xl')
  FocusEditorFixMobile()
}

const handleMultiSelect = () => {
  const blinkora = RootStore.Get(BlinkoraStore)
  blinkora.isMultiSelectMode = true
  blinkora.onMultiSelectNote(blinkora.curSelectedNote?.id!)
}

const handleSelectAll = () => {
  const blinkora = RootStore.Get(BlinkoraStore)
  blinkora.isMultiSelectMode = true

  const currentPath = new URLSearchParams(window.location.search).get('path');
  let items: Array<{ id?: number | null }> | undefined;

  if (currentPath === 'notes') {
    items = blinkora.noteOnlyList.value;
  } else if (currentPath === 'todo') {
    items = blinkora.todoList.value;
  } else if (currentPath === 'archived') {
    items = blinkora.archivedList.value;
  } else if (currentPath === 'trash') {
    items = blinkora.trashList.value;
  } else if (currentPath === 'all') {
    items = blinkora.noteList.value;
  } else {
    items = blinkora.blinkoraList.value;
  }

  const ids = (items || [])
    .map(n => n.id)
    .filter((id): id is number => typeof id === 'number');

  // Assign directly to avoid toggle side-effects
  blinkora.setMultiSelectIds(ids);
}

const handleTop = () => {
  const blinkora = RootStore.Get(BlinkoraStore)
  blinkora.upsertNote.call({
    id: blinkora.curSelectedNote?.id,
    isTop: !blinkora.curSelectedNote?.isTop
  })
}

const handleArchived = () => {
  const blinkora = RootStore.Get(BlinkoraStore)
  if (blinkora.curSelectedNote?.isRecycle) {
    return blinkora.upsertNote.call({
      id: blinkora.curSelectedNote?.id,
      isRecycle: false,
      isArchived: false
    })
  }

  if (blinkora.curSelectedNote?.isArchived) {
    return blinkora.upsertNote.call({
      id: blinkora.curSelectedNote?.id,
      isArchived: false,
    })
  }

  if (!blinkora.curSelectedNote?.isArchived) {
    return blinkora.upsertNote.call({
      id: blinkora.curSelectedNote?.id,
      isArchived: true
    })
  }
}

const handleTrash = () => {
  const blinkora = RootStore.Get(BlinkoraStore)
  PromiseCall(api.notes.trashMany.mutate({ ids: [blinkora.curSelectedNote?.id!] }))
}

const handleDelete = async () => {
  const blinkora = RootStore.Get(BlinkoraStore)
  confirmDeleteNotes({ ids: [blinkora.curSelectedNote?.id!] })
}

export const EditItem = observer(() => {
  const { t } = useTranslation();
  return <div className="flex items-start gap-2">
    <Icon icon="tabler:edit" width="20" height="20" />
    <div>{t('edit')}</div>
  </div>
})

export const MutiSelectItem = observer(() => {
  const { t } = useTranslation();
  return <div className="flex items-start gap-2" >
    <Icon icon="mingcute:multiselect-line" width="20" height="20" />
    <div>{t('multiple-select')}</div>
  </div>
})

export const SelectAllItem = observer(() => {
  const { t } = useTranslation();
  return <div className="flex items-start gap-2">
    <Icon icon="lucide:square-check" width="20" height="20" />
    <div>{t('select-all')}</div>
  </div>
})

export const ConvertItemFunction = () => {
  const blinkora = RootStore.Get(BlinkoraStore)
  blinkora.upsertNote.call({
    id: blinkora.curSelectedNote?.id,
    type: blinkora.curSelectedNote?.type == NoteType.NOTE ? NoteType.BLINKORA : NoteType.NOTE
  })
}

export const ConvertItem = observer(() => {
  const { t } = useTranslation();
  const blinkora = RootStore.Get(BlinkoraStore)
  return <div className="flex items-start gap-2">
    <Icon icon="ri:exchange-2-line" width="20" height="20" />
    <div>{t('convert-to')} {blinkora.curSelectedNote?.type == NoteType.NOTE ?
      <span className='text-yellow-500'>{t('blinkora')}</span> : <span className='text-blue-500'>{t('note')}</span>}</div>
  </div>
})

export const TopItem = observer(() => {
  const { t } = useTranslation();
  const blinkora = RootStore.Get(BlinkoraStore)
  return <div className="flex items-start gap-2">
    <Icon icon="lets-icons:pin" width="20" height="20" />
    <div>{blinkora.curSelectedNote?.isTop ? t('cancel-top') : t('top')}</div>
  </div>
})

export const ArchivedItem = observer(() => {
  const { t } = useTranslation();
  const blinkora = RootStore.Get(BlinkoraStore)
  return <div className="flex items-start gap-2">
    <Icon icon="eva:archive-outline" width="20" height="20" />
    {blinkora.curSelectedNote?.isArchived || blinkora.curSelectedNote?.isRecycle ? t('recovery') : t('archive')}
  </div>
})

export const TrashItem = observer(() => {
  const { t } = useTranslation();
  return <div className="flex items-start gap-2 text-red-500">
    <Icon icon="mingcute:delete-2-line" width="20" height="20" />
    <div>{t('trash')}</div>
  </div>
})

export const DeleteItem = observer(() => {
  const { t } = useTranslation();
  return <div className="flex items-start gap-2 text-red-500">
    <Icon icon="mingcute:delete-2-line" width="20" height="20" />
    <div>{t('delete')}</div>
  </div>
})

export const EditTimeItem = observer(() => {
  const { t } = useTranslation();
  return <div className="flex items-start gap-2">
    <Icon icon="mdi:clock-edit-outline" width="20" height="20" />
    <div>{t('edit-time')}</div>
  </div>
})

export const BlinkoraRightClickMenu = observer(() => {
  const [isDetailPage, setIsDetailPage] = useState(false)
  const location = useLocation()
  
  const blinkora = RootStore.Get(BlinkoraStore)

  useEffect(() => {
    setIsDetailPage(location.pathname.includes('/detail'))
  }, [location.pathname])

  return <ContextMenu className='font-bold' id="blink-item-context-menu" hideOnLeave={false} animation="zoom">
    <ContextMenuItem onClick={() => handleEdit(isDetailPage)}>
      <EditItem />
    </ContextMenuItem>

    {!isDetailPage ? (
      <>
        <ContextMenuItem onClick={() => handleMultiSelect()}>
          <MutiSelectItem />
        </ContextMenuItem>
        <ContextMenuItem onClick={() => handleSelectAll()}>
          <SelectAllItem />
        </ContextMenuItem>
      </>
    ) : <></>}

    <ContextMenuItem onClick={() => ShowEditTimeModel()}>
      <EditTimeItem />
    </ContextMenuItem>

    <ContextMenuItem onClick={ConvertItemFunction}>
      <ConvertItem />
    </ContextMenuItem>

    <ContextMenuItem onClick={handleTop}>
      <TopItem />
    </ContextMenuItem>

    <ContextMenuItem onClick={handleArchived}>
      <ArchivedItem />
    </ContextMenuItem>

    {!blinkora.curSelectedNote?.isRecycle ? (
      <ContextMenuItem onClick={handleTrash}>
        <TrashItem />
      </ContextMenuItem>
    ) : <></>}

    {blinkora.curSelectedNote?.isRecycle ? (
      <ContextMenuItem onClick={handleDelete}>
        <DeleteItem />
      </ContextMenuItem>
    ) : <></>}
  </ContextMenu>
})

export const LeftCickMenu = observer(({ onTrigger, className }: { onTrigger: () => void, className: string }) => {
  const [isDetailPage, setIsDetailPage] = useState(false)
  const blinkora = RootStore.Get(BlinkoraStore)
  const location = useLocation()

  useEffect(() => {
    setIsDetailPage(location.pathname.includes('/detail'))
  }, [location.pathname])

  const disabledKeys = isDetailPage ? ['MutiSelectItem'] : []

  return <Dropdown onOpenChange={e => onTrigger()}>
    <DropdownTrigger >
      <div data-drag-ignore="true" onClick={onTrigger} className={`${className} text-desc hover:text-primary cursor-pointer hover:scale-1.3 !transition-all`}>
        <Icon icon="fluent:more-vertical-16-regular" width="16" height="16" />
      </div>
    </DropdownTrigger>
    <DropdownMenu aria-label="Static Actions" disabledKeys={disabledKeys}>
      <DropdownItem key="EditItem" onPress={() => handleEdit(isDetailPage)}><EditItem /></DropdownItem>
      {!isDetailPage ? (
        <>
          <DropdownItem key="MutiSelectItem" onPress={() => handleMultiSelect()}>
            <MutiSelectItem />
          </DropdownItem>
          <DropdownItem key="SelectAllItem" onPress={() => handleSelectAll()}>
            <SelectAllItem />
          </DropdownItem>
        </>
      ) : null}
      <DropdownItem key="EditTimeItem" onPress={() => ShowEditTimeModel()}> <EditTimeItem /></DropdownItem>
      <DropdownItem key="ConvertItem" onPress={ConvertItemFunction}> <ConvertItem /></DropdownItem>
      <DropdownItem key="TopItem" onPress={handleTop}> <TopItem />  </DropdownItem>
      <DropdownItem key="ArchivedItem" onPress={handleArchived}>
        <ArchivedItem />
      </DropdownItem>

      {!blinkora.curSelectedNote?.isRecycle ? (
        <DropdownItem key="TrashItem" onPress={handleTrash}>
          <TrashItem />
        </DropdownItem>
      ) : <></>}

      {blinkora.curSelectedNote?.isRecycle ? (
        <DropdownItem key="DeleteItem" className="text-danger" onPress={handleDelete}>
          <DeleteItem />
        </DropdownItem>
      ) : <></>}

    </DropdownMenu>
  </Dropdown>
})
