import { makeAutoObservable } from "mobx";
import { RootStore } from "../root";
import { BaseState, BooleanState, NumberState } from "./base";
import { ToastPlugin } from "../module/Toast/Toast";
import { eventBus } from "@/lib/event";
import { BlinkoraStore } from "../blinkoraStore";
import i18n from "@/lib/i18n";
import { StorageState } from "./StorageState";
import { BaseStore } from "../baseStore";
import { isUnauthorizedError, localizeErrorMessage } from "@/lib/errorMessage";

export interface Events {
  data: (data: any) => void;
  error: (error: any) => void;
  select: (index: number) => void;
  update: () => void;
  finally: () => void;
  wait: () => void;
}

export const PromiseCall = async (f: Promise<any>, { autoAlert = true }: { autoAlert?: boolean, successMsg?: string } = {}) => {
  try {
    const r = await (new PromiseState({
      autoAlert,
      successMsg: i18n.t('operation-success'),
      function: async () => {
        return await f;
      }
    })).call()
    RootStore.Get(BlinkoraStore).updateTicker++
    return r
  } catch (error) {
    RootStore.Get(ToastPlugin).error(localizeErrorMessage(error));
  }
}

export class PromiseState<T extends (...args: any[]) => Promise<any>, U = ReturnType<T>> {
  sid = "PromiseState";
  key?: string;
  loading = new BooleanState();
  //@ts-ignore
  value?: Awaited<U> = null;
  defaultValue: any = null;
  function!: T;
  autoAlert = true;
  autoUpdate = false;
  context: any = undefined;
  autoInit = false;
  autoClean = false;
  autoAuthRedirect = true;
  successMsg: string = "";
  errMsg: string = "";
  loadingLock = true;
  eventKey?: string;
  currentIndex: BaseState = new NumberState({ value: 0 });
  get current() {
    if (Array.isArray(this.value) && this.value.length > 0 && !this.value[this.currentIndex.value]) {
      this.currentIndex.setValue(0);
    }
    //@ts-ignore
    return this.value[this.currentIndex.value];
  }

  async wait({ call = false } = {}): Promise<Awaited<U>> {
    return new Promise<Awaited<U>>((res, rej) => {
      if (this.value) {
        if (Array.isArray(this.value)) {
          if (this.value.length > 0) {
            res(this.value);
          }
        } else {
          res(this.value);
        }
      }

      //@ts-ignore
      if (call && !this.loading.value) this.call();
    });
  }

  constructor(args: Partial<PromiseState<T, U>> = {}) {
    Object.assign(this, args);
    if (this.defaultValue) {
      this.value = this.defaultValue;
    }
    if (this.key) {
      RootStore.init().add(this, { sid: this.key });
    } else {
      makeAutoObservable(this);
    }
  }

  async setValue(val) {
    let _val = val;
    this.value = _val;
  }

  async getOrCall(...args: Parameters<T>): Promise<Awaited<U> | undefined> {
    if (this.value) {
      if (Array.isArray(this.value)) {
        if (this.value.length > 0) {
          return this.value;
        } else {
          return this.call(...args);
        }
      } else {
        return this.value;
      }
    } else {
      return this.call(...args);
    }
  }

  async call(...args: Parameters<T>): Promise<Awaited<U> | undefined> {
    const toast = RootStore.Get(ToastPlugin);
    const base = RootStore.Get(BaseStore);
    try {
      if (this.loadingLock && this.loading.value == true) return;
      this.loading.setValue(true);
      const res = await this.function.apply(this.context, args);
      this.setValue(res);
      if (this.autoAlert && this.successMsg && res) {
        toast.success(this.successMsg);
      }
      return res;
    } catch (error) {
      if (this.autoAlert && base.isOnline) {
        if (isUnauthorizedError(error)) {
          toast.dismiss();
          if (this.autoAuthRedirect) {
            eventBus.emit('user:signout')
          }
        } else {
          const message = localizeErrorMessage(error);
          this.errMsg = message;
          toast.error(message);
        }
      } else {
        throw error;
      }
    } finally {
      this.loading.setValue(false);
      if (this.eventKey) {
        eventBus.emit(this.eventKey, this.value);
      }
    }
  }
}


export const PageSize = new StorageState<number>({ key: "pageSize", value: 30, default: 30 })
export const NoteLoadMode = new StorageState<'infinite' | 'pagination'>({
  key: "noteLoadMode",
  value: "infinite",
  default: "infinite",
  validate: (value) => value === "pagination" ? "pagination" : "infinite"
})

type PageResponse<T = any> = {
  items: T[];
  total?: number;
  page?: number;
  size?: number;
}

const isPageResponse = (value: any): value is PageResponse => {
  return value && typeof value === 'object' && Array.isArray(value.items);
}

export class PromisePageState<T extends (...args: any) => Promise<any>, U = ReturnType<T>> {
  page: number = 1;
  size = PageSize
  sid = "PromisePageState";
  key?: string;
  loading = new BooleanState();
  isLoadAll: boolean = false;
  includePageInfo: boolean = false;
  total: number = 0;
  autoAuthRedirect: boolean = true;
  get isPaginationMode() {
    return this.includePageInfo && NoteLoadMode.value === 'pagination'
  }
  get totalPages() {
    const size = Number(this.size.value) || 1;
    return Math.ceil(this.total / size);
  }
  get isEmpty() {
    if (this.loading.value) return false
    if (this.value == null) return true
    //@ts-ignore
    return this.value?.length == 0
  }
  get isLoading() {
    return this.loading.value
  }
  //@ts-ignore
  value?: Awaited<U> = [];
  defaultValue: any = [];
  function!: T;

  autoAlert = true;
  autoUpdate = false;
  autoInit = false;
  autoClean = false;
  context: any = undefined;

  successMsg: string = "";
  errMsg: string = "";

  loadingLock = true;
  private requestVersion = 0;
  private pendingResetArgs?: Parameters<T>;

  toJSON() {
    return {
      value: this.value,
    };
  }

  constructor(args: Partial<PromisePageState<T, U>> = {}) {
    Object.assign(this, args);
    if (this.defaultValue) {
      this.value = this.defaultValue;
    }
    if (this.key) {
      RootStore.init().add(this, { sid: this.key });
    } else {
      makeAutoObservable(this);
    }
  }

  async setValue(val) {
    let _val = val;
    this.value = _val;
  }

  private async call(...args: Parameters<T>): Promise<Awaited<U> | undefined> {
    const toast = RootStore.Get(ToastPlugin);
    const base = RootStore.Get(BaseStore);
    let requestVersion = 0;

    try {
      if (this.loadingLock && this.loading.value == true) {
        return
      };
      requestVersion = ++this.requestVersion;
      this.loading.setValue(true);
      if (args?.[0]) {
        Object.assign(args?.[0], { page: this.page, size: Number(this.size.value) })
      } else {
        args[0] = { page: this.page, size: Number(this.size.value) }
      }
      if (this.isPaginationMode) {
        Object.assign(args[0], { includePageInfo: true })
      }
      if (!this.isPaginationMode && this.isLoadAll) return this.value
      const res = await this.function.apply(this.context, args);
      if (requestVersion !== this.requestVersion) return this.value;
      const items = isPageResponse(res) ? res.items : res;
      if (isPageResponse(res)) {
        this.total = Number(res.total ?? items.length) || 0;
      } else if (!this.isPaginationMode && this.page == 1) {
        this.total = Array.isArray(items) ? items.length : 0;
      }
      if (!Array.isArray(items)) throw new Error("PromisePageState function must return array")
      if (this.isPaginationMode) {
        this.isLoadAll = this.totalPages > 0 ? this.page >= this.totalPages : true;
        this.setValue(items.length == 0 ? null : items);
        //@ts-ignore
        return this.value;
      }
      if (items.length == 0) {
        this.isLoadAll = true
        if (this.page == 1) {
          this.setValue(null);
        }
        //@ts-ignore
        return this.value
      }
      if (items.length == Number(this.size.value)) {
        if (this.page == 1) {
          this.setValue(items);
        } else {
          //@ts-ignore
          // Fix: Deduplicate items when concatenating pages to avoid duplicate display
          const existingMap = new Map(this.value!.map(item => [item.id, item]));
          items.forEach(item => {
            if (!existingMap.has(item.id)) {
              existingMap.set(item.id, item);
            }
          });
          this.setValue(Array.from(existingMap.values()));
        }
      } else {
        if (this.page == 1) {
          this.setValue(items);
          this.isLoadAll = true
        } else {
          //@ts-ignore
          this.setValue(this.value!.concat(items));
          this.isLoadAll = true
        }
      }

      if (this.autoAlert && this.successMsg && items) {
        toast.success(this.successMsg);
      }
      return this.value;
    } catch (error) {
      if (requestVersion !== this.requestVersion) return this.value;
      if (this.autoAlert && base.isOnline) {
        if (isUnauthorizedError(error)) {
          toast.dismiss();
          if (this.autoAuthRedirect) {
            eventBus.emit('user:signout')
          }
        } else {
          const message = localizeErrorMessage(error);
          this.errMsg = message;
          toast.error(message);
        }
      } else {
        throw error;
      }
    } finally {
      this.loading.setValue(false);
      const pendingResetArgs = this.pendingResetArgs;
      this.pendingResetArgs = undefined;
      if (pendingResetArgs) {
        queueMicrotask(() => {
          void this.resetAndCall(...pendingResetArgs);
        });
      }
    }
  }

  async resetAndCall(...args: Parameters<T>): Promise<Awaited<U> | undefined> {
    this.isLoadAll = false
    this.page = 1
    this.total = 0
    if (this.loading.value) {
      // A workspace switch can supersede a still-running list request.
      this.requestVersion++;
      this.pendingResetArgs = args;
      return;
    }
    //@ts-ignore
    return await this.call(...args)
  }
  async setPageAndCall(page: number, ...args: Parameters<T>): Promise<Awaited<U> | undefined> {
    if (this.loading.value) return
    const nextPage = Math.max(1, Math.min(Number(page) || 1, this.totalPages || Number(page) || 1));
    this.isLoadAll = false
    this.page = nextPage
    //@ts-ignore
    return await this.call(...args)
  }
  async callNextPage(...args: Parameters<T>): Promise<Awaited<U> | undefined> {
    if (this.loading.value) return
    if (this.isPaginationMode) {
      return this.setPageAndCall(this.page + 1, ...args)
    }
    this.page++
    //@ts-ignore
    return await this.call(...args)
  }
}
