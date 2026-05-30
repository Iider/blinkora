import React, { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { RootStore } from '@/store';
import { WorkspaceStore } from '@/store/workspace';
import { UserStore } from '@/store/user';
import { Icon } from '@/components/Common/Iconify/icons';
import { Button, Dropdown, DropdownTrigger, DropdownMenu, DropdownItem, Input, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Tooltip, useDisclosure } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { ToastPlugin } from '@/store/module/Toast/Toast';
import { showTipsDialog } from '@/components/Common/TipsDialog';
import { DialogStandaloneStore } from '@/store/module/DialogStandalone';
import { useMediaQuery } from '@/hooks/useMediaQuery';

export const WorkspaceSwitcher = observer(() => {
  const { t } = useTranslation();
  const workspaceStore = RootStore.Get(WorkspaceStore);
  const userStore = RootStore.Get(UserStore);
  const createDisclosure = useDisclosure();
  const manageDisclosure = useDisclosure();
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<number | null>(null);
  const [defaultWorkspaceId, setDefaultWorkspaceId] = useState<number | null>(null);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<number | null>(null);
  const isMobile = useMediaQuery('(max-width: 768px)');

  if (!userStore.isLogin) return null;

  const current = workspaceStore.currentWorkspace;
  const workspaces = workspaceStore.workspaceList;
  const isCreating = workspaceStore.create.loading.value;
  const isDeleting = workspaceStore.delete.loading.value;
  const isSettingDefault = workspaceStore.setDefault.loading.value;
  const isRenaming = workspaceStore.update.loading.value;
  const isManagingWorkspace = isDeleting || isSettingDefault || isRenaming;
  const trimmedName = newName.trim();
  const trimmedEditingName = editingName.trim();
  const isWorkspaceEditOpen = editingWorkspaceId !== null;
  const canCreate = trimmedName.length > 0 && !isCreating;
  const getWorkspaceName = (workspace?: { name?: string | null; isDefault?: boolean } | null) => {
    if (!workspace?.name) return t('workspace');
    if (workspace.isDefault && workspace.name === 'Default') return t('default-workspace');
    return workspace.name;
  };

  const handleClose = () => {
    if (isCreating) return;
    setNewName('');
    setNewDescription('');
    createDisclosure.onClose();
  };

  const handleCreate = async () => {
    if (!trimmedName) {
      RootStore.Get(ToastPlugin).error(t('name-is-required'));
      return;
    }
    if (isCreating) return;
    const workspace = await workspaceStore.create.call({ name: trimmedName, description: newDescription.trim() || undefined });
    if (!workspace) return;
    setNewName('');
    setNewDescription('');
    createDisclosure.onClose();
    RootStore.Get(ToastPlugin).success(t('create-successfully'));
  };

  const handleOpenManage = async () => {
    setEditingWorkspaceId(null);
    setEditingName('');
    await workspaceStore.list.call();
    manageDisclosure.onOpen();
  };

  const handleCreateFromManage = () => {
    if (isManagingWorkspace || isWorkspaceEditOpen) return;
    createDisclosure.onOpen();
  };

  const handleSwitchWorkspace = async (id: number) => {
    if (!Number.isFinite(id) || id === current?.id || isManagingWorkspace || isWorkspaceEditOpen) return;
    await workspaceStore.switchWorkspace(id);
  };

  const handleStartRename = (workspace: { id: number; name?: string | null }) => {
    if (isManagingWorkspace) return;
    setEditingWorkspaceId(workspace.id);
    setEditingName(workspace.name || '');
  };

  const handleCancelRename = () => {
    if (isRenaming) return;
    setEditingWorkspaceId(null);
    setEditingName('');
  };

  const handleRenameWorkspace = async (id: number) => {
    if (!trimmedEditingName) {
      RootStore.Get(ToastPlugin).error(t('name-is-required'));
      return;
    }
    if (isRenaming) return;

    setRenamingWorkspaceId(id);
    try {
      const res = await workspaceStore.update.call({ id, name: trimmedEditingName });
      if (res) {
        RootStore.Get(ToastPlugin).success(t('workspace-renamed'));
        setEditingWorkspaceId(null);
        setEditingName('');
      }
    } finally {
      setRenamingWorkspaceId(null);
    }
  };

  const handleSetDefault = async (id: number) => {
    if (isSettingDefault) return;
    setDefaultWorkspaceId(id);
    try {
      const res = await workspaceStore.setDefault.call(id);
      if (res?.success) {
        RootStore.Get(ToastPlugin).success(t('your-changes-have-been-saved'));
      }
    } finally {
      setDefaultWorkspaceId(null);
    }
  };

  const handleDeleteWorkspace = (id: number) => {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace || workspace.isDefault || isDeleting) return;

    showTipsDialog({
      size: 'sm',
      title: t('delete-workspace'),
      content: t('delete-workspace-confirm', { name: getWorkspaceName(workspace) }),
      onConfirm: async () => {
        setDeletingWorkspaceId(id);
        try {
          const res = await workspaceStore.delete.call(id);
          if (res === true || res?.success) {
            RootStore.Get(ToastPlugin).success(t('workspace-deleted'));
            RootStore.Get(DialogStandaloneStore).close();
          }
        } finally {
          setDeletingWorkspaceId(null);
        }
      },
    });
  };

  return (
    <>
      {isMobile ? (
        <Tooltip content={t('manage-workspaces')}>
          <Button
            isIconOnly
            variant="light"
            size="sm"
            aria-label={t('manage-workspaces')}
            className="mt-[2px]"
            onPress={handleOpenManage}
          >
            <Icon className="text-default-600" icon={current?.icon || 'tabler:briefcase-2'} width="24" height="24" />
          </Button>
        </Tooltip>
      ) : (
        <Dropdown placement="bottom-start">
          <DropdownTrigger>
            <Button
              variant="flat"
              size="sm"
              className="min-w-[120px] justify-between"
              endContent={<Icon icon="mdi:chevron-down" width="16" height="16" />}
            >
              <div className="flex items-center gap-2">
                <Icon icon={current?.icon || 'tabler:briefcase-2'} width="16" height="16" />
                <span className="truncate max-w-[100px]">{getWorkspaceName(current)}</span>
              </div>
            </Button>
          </DropdownTrigger>
          <DropdownMenu
            aria-label={t('workspace-switcher')}
            selectedKeys={current ? [String(current.id)] : []}
            selectionMode="single"
            onSelectionChange={(keys) => {
              const selected = Array.from(keys)[0];
              const selectedId = Number(selected);
              if (selected && Number.isFinite(selectedId) && selectedId !== current?.id) {
                workspaceStore.switchWorkspace(selectedId);
              }
            }}
          >
            {workspaces.map((ws) => (
              <DropdownItem key={String(ws.id)} textValue={getWorkspaceName(ws)}>
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-2">
                    <Icon icon={ws.icon || 'tabler:briefcase-2'} width="16" height="16" />
                    <span>{getWorkspaceName(ws)}</span>
                    {ws.isDefault && (
                      <span className="text-xs text-default-400">({t('default')})</span>
                    )}
                  </div>
                </div>
              </DropdownItem>
            ))}
            <DropdownItem key="manage" textValue={t('manage-workspaces')} onPress={handleOpenManage}>
              <div className="flex items-center gap-2">
                <Icon icon="hugeicons:settings-02" width="16" height="16" />
                <span>{t('manage-workspaces')}</span>
              </div>
            </DropdownItem>
          </DropdownMenu>
        </Dropdown>
      )}

      <Modal isOpen={createDisclosure.isOpen} onClose={handleClose} size="sm" isDismissable={!isCreating}>
        <ModalContent>
          <ModalHeader>{t('create-workspace')}</ModalHeader>
          <ModalBody>
            <Input
              label={t('name')}
              placeholder={t('workspace-name-placeholder')}
              value={newName}
              onValueChange={setNewName}
              isDisabled={isCreating}
              autoFocus
            />
            <Input
              label={t('description')}
              placeholder={t('workspace-description-placeholder')}
              value={newDescription}
              onValueChange={setNewDescription}
              isDisabled={isCreating}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={handleClose} isDisabled={isCreating}>
              {t('cancel')}
            </Button>
            <Button color="primary" onPress={handleCreate} isDisabled={!canCreate} isLoading={isCreating}>
              {t('create')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={manageDisclosure.isOpen} onClose={manageDisclosure.onClose} size="2xl" isDismissable={!isManagingWorkspace}>
        <ModalContent>
          <ModalHeader>{t('manage-workspaces')}</ModalHeader>
          <ModalBody>
            <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
              {workspaces.map((ws) => {
                const isEditing = editingWorkspaceId === ws.id;
                const isRenameUnchanged = trimmedEditingName === (ws.name || '');
                const isActionDisabled = isManagingWorkspace || (editingWorkspaceId !== null && !isEditing);

                return (
                  <div key={ws.id} className="flex flex-col gap-3 rounded-lg bg-default-100 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 flex items-start gap-3">
                      <input
                        type="radio"
                        name="current-workspace"
                        className="mt-1 h-4 w-4 shrink-0 accent-primary"
                        checked={current?.id === ws.id}
                        disabled={isManagingWorkspace || isWorkspaceEditOpen}
                        aria-label={`${t('switch-workspace')}: ${getWorkspaceName(ws)}`}
                        onChange={() => handleSwitchWorkspace(ws.id)}
                      />
                      <Icon icon={ws.icon || 'tabler:briefcase-2'} width="20" height="20" className="mt-0.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        {isEditing ? (
                          <Input
                            size="sm"
                            aria-label={t('rename-workspace')}
                            value={editingName}
                            onValueChange={setEditingName}
                            isDisabled={isRenaming}
                            autoFocus
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' && trimmedEditingName && !isRenameUnchanged) {
                                handleRenameWorkspace(ws.id);
                              }
                              if (event.key === 'Escape') {
                                handleCancelRename();
                              }
                            }}
                          />
                        ) : (
                          <>
                            <div className="flex min-w-0 items-center gap-1">
                              <span className="truncate font-medium">{getWorkspaceName(ws)}</span>
                              <Tooltip content={t('rename-workspace')}>
                                <Button
                                  isIconOnly
                                  aria-label={t('rename-workspace')}
                                  size="sm"
                                  variant="light"
                                  className="h-7 w-7 min-w-7 shrink-0 text-default-500"
                                  isDisabled={isActionDisabled}
                                  onPress={() => handleStartRename(ws)}
                                >
                                  <Icon icon="mdi:pencil-outline" width="16" height="16" />
                                </Button>
                              </Tooltip>
                            </div>
                            {ws.description && (
                              <div className="mt-1 truncate text-xs text-default-500">{ws.description}</div>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center justify-end gap-2">
                      {isEditing ? (
                        <>
                          <Button
                            size="sm"
                            variant="light"
                            isDisabled={isRenaming}
                            onPress={handleCancelRename}
                          >
                            {t('cancel')}
                          </Button>
                          <Button
                            size="sm"
                            color="primary"
                            isDisabled={!trimmedEditingName || isRenameUnchanged}
                            isLoading={isRenaming && renamingWorkspaceId === ws.id}
                            onPress={() => handleRenameWorkspace(ws.id)}
                          >
                            {t('save')}
                          </Button>
                        </>
                      ) : (
                        <>
                          {!ws.isDefault && (
                            <Button
                              size="sm"
                              variant="flat"
                              isDisabled={isActionDisabled || (isSettingDefault && defaultWorkspaceId !== ws.id)}
                              isLoading={isSettingDefault && defaultWorkspaceId === ws.id}
                              onPress={() => handleSetDefault(ws.id)}
                              startContent={<Icon icon="tabler:star" width="16" height="16" />}
                            >
                              {t('set-default-workspace')}
                            </Button>
                          )}
                          {ws.isDefault && (
                            <span className="rounded bg-primary/10 px-2 py-1 text-xs text-primary">{t('default')}</span>
                          )}
                          <Tooltip content={ws.isDefault ? t('cannot-delete-default-workspace') : t('delete-workspace')}>
                            <span className="inline-flex">
                              <Button
                                isIconOnly
                                aria-label={ws.isDefault ? t('cannot-delete-default-workspace') : t('delete-workspace')}
                                title={ws.isDefault ? t('cannot-delete-default-workspace') : t('delete-workspace')}
                                size="sm"
                                color="default"
                                variant="flat"
                                className={!ws.isDefault ? "text-default-600 hover:!bg-danger-100 hover:!text-danger" : undefined}
                                isDisabled={ws.isDefault || isActionDisabled || (isDeleting && deletingWorkspaceId !== ws.id)}
                                isLoading={isDeleting && deletingWorkspaceId === ws.id}
                                onPress={() => handleDeleteWorkspace(ws.id)}
                              >
                                <Icon icon="mingcute:delete-2-line" width="18" height="18" />
                              </Button>
                            </span>
                          </Tooltip>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button
              color="primary"
              onPress={handleCreateFromManage}
              isDisabled={isManagingWorkspace || isWorkspaceEditOpen}
              startContent={<Icon icon="mdi:plus" width="16" height="16" />}
            >
              {t('create-workspace')}
            </Button>
            <Button variant="light" onPress={manageDisclosure.onClose} isDisabled={isManagingWorkspace}>
              {t('cancel')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
});
