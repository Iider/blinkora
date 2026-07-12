"use client";
import { useEffect } from 'react';
import { NoteLoadMode, PromisePageState, PromiseState } from './standard/PromiseState';
import { Store } from './standard/base';
import { helper } from '@/lib/helper';
import { ToastPlugin } from './module/Toast/Toast';
import { RootStore } from './root';
import { eventBus } from '@/lib/event';
import { StorageListState } from './standard/StorageListState';
import i18n from '@/lib/i18n';
import { api } from '@/lib/trpc';
import { Attachment, NoteType, type Note } from '@shared/lib/types';
import { makeAutoObservable } from 'mobx';
import { UserStore } from './user';
import { BaseStore } from './baseStore';
import { StorageState } from './standard/StorageState';
import { useSearchParams, useLocation } from 'react-router-dom';

type filterType = {
  label: string;
  sortBy: string;
  direction: string;
}

// Interface for note upsert parameters
interface UpsertNoteParams {
  /** Note content */
  content?: string | null;
  /** Whether the note is archived */
  isArchived?: boolean;
  /** Whether the note is in recycle bin */
  isRecycle?: boolean;
  /** Note type */
  type?: NoteType;
  /** Note ID */
  id?: number;
  /** List of attachments */
  attachments?: Attachment[];
  /** Whether to refresh the list after operation */
  refresh?: boolean;
  /** Whether the note is pinned to top */
  isTop?: boolean;
  /** Whether to show toast notification */
  showToast?: boolean;
  /** List of referenced note IDs */
  references?: number[];
  /** Creation time */
  createdAt?: Date;
  /** Last update time */
  updatedAt?: Date;
  /** Metadata */
  metadata?: any;
}

interface MoveNoteToWorkspaceParams {
  id?: number;
  ids?: number[];
  targetWorkspaceId: number;
  targetWorkspaceName?: string;
}

interface OfflineNote extends Omit<Note, 'id' | 'references'> {
  id: number;
  isOffline: boolean;
  pendingSync: boolean;
  references: { toNoteId: number }[];
}

export class BlinkoraStore implements Store {
  sid = 'BlinkoraStore';
  noteContent = '';
  createContentStorage = new StorageState<{ content: string }>({
    key: 'createModeNote',
    default: { content: '' }
  });
  createAttachmentsStorage = new StorageListState<{ name: string, path: string, type: string, size: number }>({
    key: 'createModeAttachments',
  });
  editContentStorage = new StorageListState<{ content: string, id: number }>({
    key: 'editModeNotes'
  });
  editAttachmentsStorage = new StorageListState<{ name: string, path: string, type: string, size: number, id: number }>({
    key: 'editModeAttachments'
  });

  searchText: string = '';
  isCreateMode: boolean = true
  curSelectedNote: Note | null = null;
  curMultiSelectIds: number[] = [];
  curMultiSelectIdSet = new Set<number>();
  isMultiSelectMode: boolean = false;
  fullscreenEditorNoteId: number | null = null;
  forceQuery: number = 0;
  allTagRouter = {
    title: 'total',
    href: '/?path=all',
    icon: ''
  }
  noteListFilterConfig = {
    isArchived: false as boolean | null,
    isRecycle: false,
    type: 0,
    tagId: null as number | null,
    withoutTag: false,
    withFile: false,
    withLink: false,
    startDate: null as Date | null,
    endDate: null as Date | null,
    hasTodo: false
  }
  noteTypeDefault: NoteType = NoteType.BLINKORA
  currentCommonFilter: filterType | null = null
  updateTicker = 0
  fullNoteList: Note[] = []

  // For global search
  globalSearchTerm!: '';
  // Will be set to true when the global search modal is opened
  isGlobalSearchOpen!: false;
  // For search results presentation
  searchResults = {
    notes: [],
    resources: [],
    settings: []
  };

  offlineNoteStorage = new StorageListState<OfflineNote>({ key: 'offlineNotes' });

  get offlineNotes(): OfflineNote[] {
    return this.offlineNoteStorage.list;
  }

  get isOnline(): boolean {
    return RootStore.Get(BaseStore).isOnline;
  }

  private saveOfflineNote(note: OfflineNote) {
    this.offlineNoteStorage.push(note);
  }

  private removeOfflineNote(id: number) {
    const index = this.offlineNoteStorage.list?.findIndex(note => note.id === id);
    if (index !== -1) {
      this.offlineNoteStorage.remove(index);
    }
  }

  private async getFilteredNotes(params: {
    page: number;
    size: number;
    includePageInfo?: boolean;
    filterConfig: any;
    offlineFilter?: (note: OfflineNote) => boolean | undefined;
  }) {
    const { page, size, includePageInfo = false, filterConfig, offlineFilter = () => true } = params;
    let notes: Note[] = [];
    let total = 0;

    if (this.isOnline) {
      const queryParams = { 
        ...this.noteListFilterConfig, 
        ...filterConfig,
        searchText: this.searchText, 
        page, 
        size,
        includePageInfo
      };
      const res = await api.notes.list.mutate(queryParams);
      if (includePageInfo && res && typeof res === 'object' && Array.isArray(res.items)) {
        notes = res.items;
        total = Number(res.total ?? notes.length) || 0;
      } else {
        notes = res;
        total = Array.isArray(notes) ? notes.length : 0;
      }

      
      if (this.offlineNotes.length > 0) {
        await this.syncOfflineNotes();
      }
    }

    const filteredOfflineNotes = this.offlineNotes.filter(offlineFilter);
    const mergedNotes = [...filteredOfflineNotes, ...notes].map(i => ({ ...i, isExpand: false }));

    if (!this.isOnline) {
      const start = (page - 1) * size;
      const end = start + size;
      const items = mergedNotes.slice(start, end);
      return includePageInfo
        ? { items, total: mergedNotes.length, page, size }
        : items;
    }

    return includePageInfo
      ? { items: mergedNotes, total: total + filteredOfflineNotes.length, page, size }
      : mergedNotes;
  }

  upsertNote = new PromiseState({
    eventKey: 'upsertNote',
    function: async (params: UpsertNoteParams) => {
      console.log("upsertNote", params)
      const {
        content = null,
        isArchived,
        isRecycle,
        type,
        id,
        attachments = [],
        refresh = true,
        isTop,
        showToast = true,
        references = [],
        createdAt: inputCreatedAt,
        updatedAt: inputUpdatedAt,
        metadata
      } = params;

      if (!this.isOnline && !id) {
        const now = new Date();
        const offlineNote: OfflineNote = {
          id: now.getTime(),
          content: content || '',
          type,
          isArchived: !!isArchived,
          isRecycle: !!isRecycle,
          attachments: attachments || [],
          isTop: !!isTop,
          references: references.map(refId => ({ toNoteId: refId })),
          createdAt: now,
          updatedAt: now,
          isOffline: true,
          pendingSync: true,
          tags: [],
          metadata: metadata || {}
        };

        this.saveOfflineNote(offlineNote);
        showToast && RootStore.Get(ToastPlugin).success(i18n.t("create-successfully") + '-' + i18n.t("offline-status"));
        return offlineNote;
      }

      const res = await api.notes.upsert.mutate({
        content,
        type,
        isArchived,
        isRecycle,
        id,
        attachments,
        isTop,
        references,
        createdAt: inputCreatedAt ? new Date(inputCreatedAt) : undefined,
        updatedAt: inputUpdatedAt ? new Date(inputUpdatedAt) : undefined,
        metadata
      });
      eventBus.emit('editor:clear')
      showToast && RootStore.Get(ToastPlugin).success(id ? i18n.t("update-successfully") : i18n.t("create-successfully"))
      refresh && this.updateTicker++
      return res
    }
  })

  moveNoteToWorkspace = new PromiseState({
    function: async ({ id, ids, targetWorkspaceId, targetWorkspaceName }: MoveNoteToWorkspaceParams) => {
      const noteIds = ids?.length ? ids : id ? [id] : [];
      const res = await api.notes.moveToWorkspace.mutate({ ids: noteIds, targetWorkspaceId });
      const toastKey = noteIds.length > 1 ? "cards-moved-to-workspace" : "card-moved-to-workspace";
      RootStore.Get(ToastPlugin).success(i18n.t(toastKey, {
        count: noteIds.length,
        name: targetWorkspaceName || i18n.t("workspace")
      }));
      this.updateTicker++;
      return res;
    }
  })

  async syncOfflineNotes() {
    if (!this.isOnline) return;

    const offlineNotes = [...this.offlineNotes];
    for (const note of offlineNotes) {
      if (note.pendingSync) {
        try {
          const { id, isOffline, pendingSync, references, ...noteData } = note;
          const onlineNote: UpsertNoteParams = {
            ...noteData,
            references: references.map(ref => ref.toNoteId),
            showToast: false
          };
          await this.upsertNote.call(onlineNote);
          this.removeOfflineNote(id);
        } catch (error) {
          console.error('Failed to sync offline note:', error);
        }
      }
    }
    this.updateTicker++;
  }

  blinkoraList = new PromisePageState({
    includePageInfo: true,
    function: async ({ page, size, includePageInfo }) => {
      return this.getFilteredNotes({
        page,
        size,
        includePageInfo,
        filterConfig: {
          type: NoteType.BLINKORA,
          isArchived: false,
          isRecycle: false
        },
        offlineFilter: (note: OfflineNote) => {
          return Boolean(note.type === NoteType.BLINKORA && !note.isArchived && !note.isRecycle);
        }
      });
    }
  })

  noteOnlyList = new PromisePageState({
    includePageInfo: true,
    function: async ({ page, size, includePageInfo }) => {
      return this.getFilteredNotes({
        page,
        size,
        includePageInfo,
        filterConfig: {
          type: NoteType.NOTE,
          isArchived: false,
          isRecycle: false
        },
        offlineFilter: (note: OfflineNote) => {
          return Boolean(note.type === NoteType.NOTE && !note.isArchived && !note.isRecycle);
        }
      });
    }
  })

  todoList = new PromisePageState({
    includePageInfo: true,
    function: async ({ page, size, includePageInfo }) => {
      return this.getFilteredNotes({
        page,
        size,
        includePageInfo,
        filterConfig: {
          type: NoteType.TODO,
          isArchived: false,
          isRecycle: false
        },
        offlineFilter: (note: OfflineNote) => {
          return Boolean(note.type === NoteType.TODO && !note.isArchived && !note.isRecycle);
        }
      });
    }
  })

  archivedList = new PromisePageState({
    includePageInfo: true,
    function: async ({ page, size, includePageInfo }) => {
      return this.getFilteredNotes({
        page,
        size,
        includePageInfo,
        filterConfig: {
          isArchived: true,
          isRecycle: false
        },
        offlineFilter: (note: OfflineNote) => {
          return Boolean(note.isArchived && !note.isRecycle);
        }
      });
    }
  })

  trashList = new PromisePageState({
    includePageInfo: true,
    function: async ({ page, size, includePageInfo }) => {
      return this.getFilteredNotes({
        page,
        size,
        includePageInfo,
        filterConfig: {
          isRecycle: true
        },
        offlineFilter: (note: OfflineNote) => {
          return Boolean(note.isRecycle);
        }
      });
    }
  })

  noteList = new PromisePageState({
    includePageInfo: true,
    function: async ({ page, size, includePageInfo, ...filterConfig }) => {
      return this.getFilteredNotes({
        page,
        size,
        includePageInfo,
        filterConfig: {
          isArchived: false,
          ...filterConfig
        },
        offlineFilter: (note) => {
          // Exclude notes in recycle bin
          return !note.isRecycle;
        }
      });
    }
  })

  referenceSearchList = new PromisePageState({
    function: async ({ page, size, searchText }) => {
      return await api.notes.list.mutate({
        searchText
      })
    }
  })

  noteDetail = new PromiseState({
    function: async ({ id }) => {
      return await api.notes.detail.mutate({ id })
    }
  })

  dailyReviewNoteList = new PromiseState({
    function: async () => {
      return await api.notes.dailyReviewNoteList.query()
    }
  })

  randomReviewNoteList = new PromiseState({
    function: async ({ limit = 30 }) => {
      return await api.notes.randomNoteList.query({ limit })
    }
  })

  resourceList = new PromisePageState({
    function: async ({ page, size, searchText, folder }) => {
      return await api.attachments.list.query({ page, size, searchText, folder })
    }
  })

  tagList = new PromiseState({
    function: async () => {
      const falttenTags = await api.tags.list.query(undefined, { context: { skipBatch: true } });
      const listTags = helper.buildHashTagTreeFromDb(falttenTags)
      console.log(falttenTags, 'listTags')
      let pathTags: string[] = [];
      listTags.forEach(node => {
        pathTags = pathTags.concat(helper.generateTagPaths(node));
      });
      return { falttenTags, listTags, pathTags }
    }
  })

  get showAi() {
    return false
  }

  config = new PromiseState({
    loadingLock: false,
    function: async () => {
      const res = await api.config.list.query()
      return res
    }
  })

  async onBottom() {
    const currentPath = new URLSearchParams(window.location.search).get('path');
    
    if (currentPath === 'notes') {
      await this.noteOnlyList.callNextPage({});
    } else if (currentPath === 'todo') {
      await this.todoList.callNextPage({});
    } else if (currentPath === 'archived') {
      await this.archivedList.callNextPage({});
    } else if (currentPath === 'trash') {
      await this.trashList.callNextPage({});
    } else if (currentPath === 'all') {
      await this.noteList.callNextPage({});
    } else {
      await this.blinkoraList.callNextPage({});
    }
  }

  onMultiSelectNote(id: number) {
    if (this.curMultiSelectIdSet.has(id)) {
      this.curMultiSelectIdSet.delete(id);
    } else {
      this.curMultiSelectIdSet.add(id);
    }
    this.curMultiSelectIds = Array.from(this.curMultiSelectIdSet);
    if (this.curMultiSelectIds.length == 0) {
      this.isMultiSelectMode = false
    }
  }

  setMultiSelectIds(ids: number[]) {
    const uniqueIds = Array.from(new Set(ids));
    this.curMultiSelectIds = uniqueIds;
    this.curMultiSelectIdSet.clear();
    uniqueIds.forEach(id => this.curMultiSelectIdSet.add(id));
    this.isMultiSelectMode = uniqueIds.length > 0;
  }

  selectAllCurrentListNotes() {
    const currentPath = new URLSearchParams(window.location.search).get('path');
    let items: Note[] | undefined;

    if (currentPath === 'notes') {
      items = this.noteOnlyList.value;
    } else if (currentPath === 'todo') {
      items = this.todoList.value;
    } else if (currentPath === 'archived') {
      items = this.archivedList.value;
    } else if (currentPath === 'trash') {
      items = this.trashList.value;
    } else if (currentPath === 'all') {
      items = this.noteList.value;
    } else {
      items = this.blinkoraList.value;
    }

    const ids = (items ?? [])
      .map(note => note.id)
      .filter((id): id is number => typeof id === 'number');
    this.setMultiSelectIds(ids);
  }

  onMultiSelectRest() {
    this.isMultiSelectMode = false
    this.curMultiSelectIds = []
    this.curMultiSelectIdSet.clear()
    // Fix: Remove updateTicker++ to avoid unnecessary list refresh and duplicate display
    // this.updateTicker++
  }

  firstLoad() {
    this.tagList.call()
    this.config.call()
    this.dailyReviewNoteList.call()
  }

  private getPageFromSearchParams(searchParams: URLSearchParams, fallbackPage = 1) {
    const page = Number(searchParams.get('page') || fallbackPage) || fallbackPage
    return Math.max(1, page)
  }

  private refreshListAtCurrentPage(list: PromisePageState<any>, searchParams: URLSearchParams, fallbackPage = 1) {
    const page = this.getPageFromSearchParams(searchParams, fallbackPage)
    return NoteLoadMode.value === 'pagination' && page > 1
      ? list.setPageAndCall(page, {})
      : list.resetAndCall({})
  }


  async refreshData() {
    // Fix: Clear multi-select state when refreshing data to avoid stale selections
    this.onMultiSelectRest();

    this.tagList.call()

    const searchParams = new URLSearchParams(window.location.search);
    const currentPath = searchParams.get('path');
    
    if (currentPath === 'notes') {
      this.refreshListAtCurrentPage(this.noteOnlyList, searchParams, this.noteOnlyList.page);
    } else if (currentPath === 'todo') {
      this.refreshListAtCurrentPage(this.todoList, searchParams, this.todoList.page);
    } else if (currentPath === 'archived') {
      this.refreshListAtCurrentPage(this.archivedList, searchParams, this.archivedList.page);
    } else if (currentPath === 'trash') {
      this.refreshListAtCurrentPage(this.trashList, searchParams, this.trashList.page);
    } else if (currentPath === 'all') {
      this.refreshListAtCurrentPage(this.noteList, searchParams, this.noteList.page);
    } else {
      this.refreshListAtCurrentPage(this.blinkoraList, searchParams, this.blinkoraList.page);
    }
    
    this.config.call()
    this.dailyReviewNoteList.call()
  }

  private clear() {
    this.createContentStorage.clear()
    this.editContentStorage.clear()
  }

  use() {
    useEffect(() => {
      if (RootStore.Get(UserStore).id) {
        console.log('firstLoad', RootStore.Get(UserStore).id)
        this.firstLoad()
      }
    }, [RootStore.Get(UserStore).id])

    useEffect(() => {
      if (this.updateTicker == 0) return
      console.log('updateTicker', this.updateTicker)
      this.refreshData()
    }, [this.updateTicker])
  }

  useQuery() {
    const [searchParams] = useSearchParams();
    const location = useLocation();
    useEffect(() => {
      const tagId = searchParams.get('tagId');
      const withoutTag = searchParams.get('withoutTag');
      const withFile = searchParams.get('withFile');
      const withLink = searchParams.get('withLink');
      const searchText = searchParams.get('searchText') || this.searchText;
      const hasTodo = searchParams.get('hasTodo');
      const path = searchParams.get('path');
      const loadList = (list: PromisePageState<any>) => {
        return this.refreshListAtCurrentPage(list, searchParams);
      }

      this.noteListFilterConfig.type = NoteType.BLINKORA
      this.noteTypeDefault = NoteType.BLINKORA
      this.noteListFilterConfig.tagId = null
      this.noteListFilterConfig.isArchived = false
      this.noteListFilterConfig.withoutTag = false
      this.noteListFilterConfig.withLink = false
      this.noteListFilterConfig.withFile = false
      this.noteListFilterConfig.isRecycle = false
      this.noteListFilterConfig.startDate = null
      this.noteListFilterConfig.endDate = null
      this.noteListFilterConfig.hasTodo = false

      // Fix: Clear multi-select state when switching paths to avoid stale selections
      this.onMultiSelectRest();

      if (tagId) {
        this.noteListFilterConfig.tagId = Number(tagId) as number
      }
      if (withoutTag) {
        this.noteListFilterConfig.withoutTag = true
      }
      if (withLink) {
        this.noteListFilterConfig.withLink = true
      }
      if (withFile) {
        this.noteListFilterConfig.withFile = true
      }
      if (hasTodo) {
        this.noteListFilterConfig.hasTodo = true
      }
      if (searchText) {
        this.searchText = searchText as string;
      } else {
        this.searchText = '';
      }

      if (path == 'notes') {
        this.noteListFilterConfig.type = NoteType.NOTE
        loadList(this.noteOnlyList);
      } else if (path == 'todo') {
        this.noteListFilterConfig.type = NoteType.TODO
        loadList(this.todoList);
      } else if (path == 'all') {
        this.noteListFilterConfig.type = -1
        loadList(this.noteList);
      } else if (path == 'archived') {
        this.noteListFilterConfig.type = -1
        this.noteListFilterConfig.isArchived = true
        loadList(this.archivedList);
      } else if (path == 'trash') {
        this.noteListFilterConfig.type = -1
        this.noteListFilterConfig.isRecycle = true
        loadList(this.trashList);
      } else {
        loadList(this.blinkoraList);
      }
    }, [this.forceQuery, location.pathname, searchParams])
  }

  settingsSearchText: string = '';
  constructor() {
    makeAutoObservable(this)
    eventBus.on('user:signout', () => {
      this.clear()
    })
    eventBus.on('workspace:switched', () => {
      this.refreshData()
    })
  }

  removeAttachmentFromClient(file: { name?: string, path?: string }, noteId?: number) {
    const isSameFile = (item: { name?: string, path?: string }) => {
      if (file.path && item.path) return item.path === file.path;
      return item.name === file.name;
    }

    this.createAttachmentsStorage.save(this.createAttachmentsStorage.list.filter(item => !isSameFile(item)));
    this.editAttachmentsStorage.save(this.editAttachmentsStorage.list.filter(item => {
      if (noteId && Number(item.id) !== Number(noteId)) return true;
      return !isSameFile(item);
    }));

    if (this.curSelectedNote && (!noteId || Number(this.curSelectedNote.id) === Number(noteId))) {
      this.curSelectedNote.attachments = this.curSelectedNote.attachments?.filter(item => !isSameFile(item)) ?? [];
    }

    this.updateTicker++;
  }

  updateTagFilter(tagId: number) {
    this.noteListFilterConfig.tagId = tagId;
    this.noteListFilterConfig.type = -1
    this.noteList.resetAndCall({});
  }
}
