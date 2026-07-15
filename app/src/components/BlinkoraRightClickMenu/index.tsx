import { observer } from "mobx-react-lite";
import { BlinkoraStore } from '@/store/blinkoraStore';
import { Dropdown, DropdownTrigger, DropdownMenu, DropdownItem, Button, DatePicker, Select, SelectItem } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { ContextMenu, ContextMenuItem } from '@/components/Common/ContextMenu';
import { Icon } from '@/components/Common/Iconify/icons';
import { PromiseCall } from '@/store/standard/PromiseState';
import { api } from '@/lib/trpc';
import { RootStore } from "@/store";
import { DialogStore } from "@/store/module/Dialog";
import { ToastPlugin } from "@/store/module/Toast/Toast";
import { BlinkoraEditor } from "../BlinkoraEditor";
import { useEffect, useState } from "react";
import { NoteType, toNoteTypeEnum } from "@shared/lib/types";
import { parseAbsoluteToLocal } from "@internationalized/date";
import i18n from "@/lib/i18n";
import { useLocation } from "react-router-dom";
import { FocusEditorFixMobile } from "@/components/Common/Editor/editorUtils";
import { confirmDeleteNotes } from "@/lib/noteDeletion";
import { WorkspaceStore } from "@/store/workspace";
import { getNoteTypeOption, NOTE_TYPE_OPTIONS } from "../Common/NoteTypePicker";
import { writeTextToClipboard } from "@/lib/clipboard";
import { getBlinkoraEndpoint } from "@/lib/blinkoraEndpoint";
import { findPreviewTitle } from "../BlinkoraCard/cardPreview";

const AGENT_DISCUSSION_TITLE_MAX_LENGTH = 80;

const truncateTitle = (title: string) => {
  const characters = Array.from(title);
  if (characters.length <= AGENT_DISCUSSION_TITLE_MAX_LENGTH) return title;
  return `${characters.slice(0, AGENT_DISCUSSION_TITLE_MAX_LENGTH).join('').trimEnd()}...`;
};

const escapeMarkdownLinkLabel = (value: string) => value
  .replace(/[\r\n]+/g, ' ')
  .replace(/([\\\[\]])/g, '\\$1');

const toIsoString = (value?: string | Date | null) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const toLocalDateValue = (value?: string | Date | null) => {
  const isoString = toIsoString(value);
  return isoString ? parseAbsoluteToLocal(isoString) : null;
};

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
        toLocalDateValue(blinkora.curSelectedNote.createdAt) : null);

      const [updatedAt, setUpdatedAt] = useState(blinkora.curSelectedNote?.updatedAt ?
        toLocalDateValue(blinkora.curSelectedNote.updatedAt) : null);

      const [expireAt, setExpireAt] = useState(blinkora.curSelectedNote?.metadata?.expireAt ?
        toLocalDateValue(blinkora.curSelectedNote.metadata.expireAt) : null);

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
  const initialNoteType = mode === 'edit'
    ? toNoteTypeEnum(blinkora.curSelectedNote?.type)
    : undefined;
  RootStore.Get(DialogStore).setData({
    size: size as any,
    isOpen: true,
    onlyContent: true,
    isDismissable: false,
    showOnlyContentCloseButton: true,
    content: <BlinkoraEditor isInDialog mode={mode} initialData={initialData} initialNoteType={initialNoteType} key={`editor-key-${mode}`} onSended={() => {
      RootStore.Get(DialogStore).close()
      blinkora.isCreateMode = false
    }} />
  })
}

type MoveWorkspaceModelOptions = {
  ids?: number[];
  onMoved?: () => void;
}

export const ShowMoveWorkspaceModel = (options: MoveWorkspaceModelOptions = {}) => {
  const blinkora = RootStore.Get(BlinkoraStore)
  const workspaceStore = RootStore.Get(WorkspaceStore)
  const currentWorkspaceId = workspaceStore.workspaceId
  const targetWorkspaces = workspaceStore.workspaceList.filter(workspace => workspace.id !== currentWorkspaceId)
  const selectedNoteIds = Array.from(new Set(
    (options.ids?.length ? options.ids : blinkora.curSelectedNote?.id ? [blinkora.curSelectedNote.id] : [])
      .filter((id): id is number => Number.isFinite(id) && id > 0)
  ))

  if (selectedNoteIds.length === 0) return;
  if (!options.ids?.length && blinkora.curSelectedNote?.isRecycle) {
    RootStore.Get(ToastPlugin).error(i18n.t('cannot-move-recycled-card'))
    return;
  }
  if (targetWorkspaces.length === 0) {
    RootStore.Get(ToastPlugin).error(i18n.t('no-other-workspace'))
    return;
  }

  RootStore.Get(DialogStore).setData({
    size: 'sm' as any,
    isOpen: true,
    onlyContent: true,
    isDismissable: true,
    showOnlyContentCloseButton: true,
    content: () => {
      const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(String(targetWorkspaces[0].id));
      const [isMoving, setIsMoving] = useState(false);
      const selectedWorkspace = targetWorkspaces.find(workspace => String(workspace.id) === selectedWorkspaceId);

      const handleMove = async () => {
        if (!selectedWorkspace || !blinkora.curSelectedNote?.id) return;
        setIsMoving(true);
        try {
          const moved = await blinkora.moveNoteToWorkspace.call({
            ids: selectedNoteIds,
            targetWorkspaceId: selectedWorkspace.id,
            targetWorkspaceName: selectedWorkspace.name
          });
          if (moved) {
            options.onMoved?.();
            RootStore.Get(DialogStore).close();
          }
        } finally {
          setIsMoving(false);
        }
      }

      return <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1">
          <div className="text-lg font-semibold">{i18n.t('move-card-to-workspace')}</div>
          <div className="text-sm text-default-500">{i18n.t('select-target-workspace')}</div>
        </div>
        <Select
          aria-label={i18n.t('select-target-workspace')}
          selectedKeys={selectedWorkspaceId ? [selectedWorkspaceId] : []}
          onChange={e => setSelectedWorkspaceId(e.target.value)}
        >
          {targetWorkspaces.map(workspace => (
            <SelectItem key={String(workspace.id)} textValue={workspace.name}>
              <div className="flex items-center gap-2">
                <Icon icon={workspace.icon || 'tabler:briefcase-2'} width="16" height="16" />
                <span>{workspace.name}</span>
              </div>
            </SelectItem>
          ))}
        </Select>
        <div className="flex justify-end gap-2">
          <Button variant="light" onPress={() => RootStore.Get(DialogStore).close()}>
            {i18n.t('cancel')}
          </Button>
          <Button color="primary" isLoading={isMoving} isDisabled={!selectedWorkspace} onPress={handleMove}>
            {i18n.t('move-to-workspace')}
          </Button>
        </div>
      </div>
    }
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

const handleAgentDiscussion = async () => {
  const blinkora = RootStore.Get(BlinkoraStore)
  const workspaceStore = RootStore.Get(WorkspaceStore)
  const note = blinkora.curSelectedNote

  if (!note?.id) {
    RootStore.Get(ToastPlugin).error(i18n.t('operation-failed'))
    return
  }

  const title = truncateTitle(
    findPreviewTitle(note.content ?? '', note.title ?? '') || i18n.t('no-title')
  )
  const content = i18n.t('agent-discussion-copy-template', {
    id: note.id,
    title: escapeMarkdownLinkLabel(title),
    workspace: escapeMarkdownLinkLabel(workspaceStore.currentWorkspace?.name || i18n.t('workspace')),
    url: getBlinkoraEndpoint(`/detail?id=${note.id}`)
  })

  try {
    await writeTextToClipboard(content)
    RootStore.Get(ToastPlugin).success(i18n.t('agent-discussion-copied'))
  } catch {
    RootStore.Get(ToastPlugin).error(i18n.t('operation-failed'))
  }
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

export const AgentDiscussionItem = observer(() => {
  const { t } = useTranslation();
  return <div className="flex items-start gap-2">
    <Icon icon="hugeicons:bubble-chat-add" width="20" height="20" />
    <div>{t('agent-discussion')}</div>
  </div>
})

const getConvertTargetOptions = (currentType?: number | NoteType) => {
  const safeCurrentType = toNoteTypeEnum(currentType);
  return NOTE_TYPE_OPTIONS.filter(option => option.type !== safeCurrentType);
}

export const ConvertItemFunction = (targetType: NoteType) => {
  const blinkora = RootStore.Get(BlinkoraStore)
  blinkora.upsertNote.call({
    id: blinkora.curSelectedNote?.id,
    type: targetType
  })
}

export const ConvertItem = observer(({ targetType }: { targetType: NoteType }) => {
  const { t } = useTranslation();
  const option = getNoteTypeOption(targetType);
  return <div className="flex items-start gap-2">
    <Icon icon="ri:exchange-2-line" width="20" height="20" />
    <div>{t('convert-to')} <span className={option.iconClassName}>{t(option.labelKey)}</span></div>
  </div>
})

export const MoveWorkspaceItem = observer(({ isDisabled = false }: { isDisabled?: boolean }) => {
  const { t } = useTranslation();
  return <div className={`flex items-start gap-2 ${isDisabled ? 'text-default-400' : ''}`}>
    <Icon icon="tabler:briefcase-2" width="20" height="20" />
    <div>{t('move-to-workspace')}</div>
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
  const workspaceStore = RootStore.Get(WorkspaceStore)
  const canMoveToWorkspace = !blinkora.curSelectedNote?.isRecycle && workspaceStore.workspaceList.some(workspace => workspace.id !== workspaceStore.workspaceId)

  useEffect(() => {
    setIsDetailPage(location.pathname.includes('/detail'))
  }, [location.pathname])

  useEffect(() => {
    if (workspaceStore.workspaceList.length === 0) {
      workspaceStore.list.call()
    }
  }, [workspaceStore])

  const handleMoveWorkspace = () => {
    if (!canMoveToWorkspace) {
      RootStore.Get(ToastPlugin).error(i18n.t('no-other-workspace'))
      return;
    }
    ShowMoveWorkspaceModel()
  }

  return <ContextMenu className='font-bold' id="blink-item-context-menu" hideOnLeave={false} animation="zoom">
    <ContextMenuItem onClick={() => handleEdit(isDetailPage)}>
      <EditItem />
    </ContextMenuItem>

    {!isDetailPage ? (
      <>
        <ContextMenuItem onClick={() => handleMultiSelect()}>
          <MutiSelectItem />
        </ContextMenuItem>
      </>
    ) : <></>}

    <ContextMenuItem onClick={handleAgentDiscussion}>
      <AgentDiscussionItem />
    </ContextMenuItem>

    <ContextMenuItem onClick={() => ShowEditTimeModel()}>
      <EditTimeItem />
    </ContextMenuItem>

    {getConvertTargetOptions(blinkora.curSelectedNote?.type).map(option => (
      <ContextMenuItem key={`ConvertItem-${option.type}`} onClick={() => ConvertItemFunction(option.type)}>
        <ConvertItem targetType={option.type} />
      </ContextMenuItem>
    ))}

    {!blinkora.curSelectedNote?.isRecycle ? (
      <ContextMenuItem onClick={handleMoveWorkspace}>
        <MoveWorkspaceItem isDisabled={!canMoveToWorkspace} />
      </ContextMenuItem>
    ) : <></>}

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
  const workspaceStore = RootStore.Get(WorkspaceStore)
  const location = useLocation()

  useEffect(() => {
    setIsDetailPage(location.pathname.includes('/detail'))
  }, [location.pathname])

  useEffect(() => {
    if (workspaceStore.workspaceList.length === 0) {
      workspaceStore.list.call()
    }
  }, [workspaceStore])

  const canMoveToWorkspace = !blinkora.curSelectedNote?.isRecycle && workspaceStore.workspaceList.some(workspace => workspace.id !== workspaceStore.workspaceId)
  const disabledKeys = [
    ...(isDetailPage ? ['MutiSelectItem'] : []),
    ...(!canMoveToWorkspace ? ['MoveWorkspaceItem'] : [])
  ]

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
        </>
      ) : null}
      <DropdownItem key="AgentDiscussionItem" onPress={handleAgentDiscussion}>
        <AgentDiscussionItem />
      </DropdownItem>
      <DropdownItem key="EditTimeItem" onPress={() => ShowEditTimeModel()}> <EditTimeItem /></DropdownItem>
      {getConvertTargetOptions(blinkora.curSelectedNote?.type).map(option => (
        <DropdownItem key={`ConvertItem-${option.type}`} onPress={() => ConvertItemFunction(option.type)}>
          <ConvertItem targetType={option.type} />
        </DropdownItem>
      ))}
      {!blinkora.curSelectedNote?.isRecycle ? (
        <DropdownItem key="MoveWorkspaceItem" onPress={ShowMoveWorkspaceModel}>
          <MoveWorkspaceItem isDisabled={!canMoveToWorkspace} />
        </DropdownItem>
      ) : null}
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
