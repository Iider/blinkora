import { makeAutoObservable } from 'mobx';
import { Store } from './standard/base';
import { PromiseState } from './standard/PromiseState';
import { api } from '@/lib/trpc';
import { StorageState } from './standard/StorageState';
import { eventBus } from '@/lib/event';

export interface Workspace {
  id: number;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  accountId: number;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class WorkspaceStore implements Store {
  sid = 'workspace';

  currentWorkspaceId = new StorageState<number | null>({
    key: 'blinkoraCurrentWorkspaceId',
    value: null
  });

  workspaceList: Workspace[] = [];
  isLoading = false;

  constructor() {
    makeAutoObservable(this);
    eventBus.on('user:signout', () => {
      this.currentWorkspaceId.save(null);
      this.workspaceList = [];
    });
  }

  get currentWorkspace(): Workspace | null {
    if (!this.currentWorkspaceId.value) return null;
    return this.workspaceList.find(w => w.id === this.currentWorkspaceId.value) || null;
  }

  get workspaceId(): number | undefined {
    return this.currentWorkspaceId.value ?? undefined;
  }

  list = new PromiseState({
    function: async () => {
      const res = await api.workspaces.list.query();
      this.workspaceList = res as Workspace[];
      return res;
    }
  });

  create = new PromiseState({
    function: async (data: { name: string; description?: string; icon?: string; color?: string }) => {
      const res = await api.workspaces.create.mutate(data) as Workspace;
      await this.list.call();

      const createdId = Number(res?.id);
      if (Number.isFinite(createdId)) {
        this.switchWorkspace(createdId);
      }

      return res;
    }
  });

  update = new PromiseState({
    function: async (data: { id: number; name?: string; description?: string; icon?: string; color?: string }) => {
      const res = await api.workspaces.update.mutate(data);
      await this.list.call();
      return res;
    }
  });

  delete = new PromiseState({
    function: async (id: number) => {
      const wasCurrentWorkspace = Number(this.currentWorkspaceId.value) === Number(id);
      const fallbackWorkspace = wasCurrentWorkspace
        ? this.workspaceList.find(w => w.isDefault && Number(w.id) !== Number(id))
        : undefined;

      const res = await api.workspaces.delete.mutate({ id });

      if (wasCurrentWorkspace) {
        if (fallbackWorkspace) {
          this.switchWorkspace(fallbackWorkspace.id);
        } else {
          this.currentWorkspaceId.save(null);
          eventBus.emit('workspace:switched', null);
        }
      }

      await this.list.call();

      if (wasCurrentWorkspace) {
        const defaultWs = this.workspaceList.find(w => w.isDefault) || this.workspaceList[0];
        if (defaultWs && Number(this.currentWorkspaceId.value) !== Number(defaultWs.id)) {
          this.switchWorkspace(defaultWs.id);
        } else if (!defaultWs) {
          this.currentWorkspaceId.save(null);
          eventBus.emit('workspace:switched', null);
        }
      }

      return res;
    }
  });

  setDefault = new PromiseState({
    function: async (id: number) => {
      const res = await api.workspaces.setDefault.mutate({ id });
      await this.list.call();
      return res;
    }
  });

  switchWorkspace(id: number) {
    this.currentWorkspaceId.save(id);
    eventBus.emit('workspace:switched', id);
  }

  async initWorkspaces(isLogin = true) {
    if (!isLogin) return;
    await this.list.call();
    const currentWorkspaceExists = this.workspaceList.some(w => w.id === this.currentWorkspaceId.value);
    if (this.workspaceList.length > 0 && !currentWorkspaceExists) {
      const defaultWs = this.workspaceList.find(w => w.isDefault);
      if (defaultWs) {
        this.currentWorkspaceId.save(defaultWs.id);
      } else {
        this.currentWorkspaceId.save(this.workspaceList[0].id);
      }
    }
  }

  use() {
    // No React hooks needed for now
  }
}
