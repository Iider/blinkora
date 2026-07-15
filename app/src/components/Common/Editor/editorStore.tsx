import { RootStore } from '@/store';
import { PromiseState } from '@/store/standard/PromiseState';
import { helper } from '@/lib/helper';
import { FileType, OnSendContentType } from './type';
import { BlinkoraStore } from '@/store/blinkoraStore';
import { api } from '@/lib/trpc';
import { getEditorElements, type ViewMode } from './editorUtils';
import { makeAutoObservable } from 'mobx';
import Vditor from 'vditor';
import { showTipsDialog } from '../TipsDialog';
import i18n from '@/lib/i18n';
import { DialogStandaloneStore } from '@/store/module/DialogStandalone';
import { Button } from '@heroui/react';
import axios from 'axios';
import { ToastPlugin } from '@/store/module/Toast/Toast';
import { NoteType } from '@shared/lib/types';
import { eventBus } from '@/lib/event';
import { getBlinkoraEndpoint, stripBlinkoraFileAccessTokensFromText } from '@/lib/blinkoraEndpoint';
import axiosInstance from '@/lib/axios';

export class EditorStore {
  files: FileType[] = []
  lastRange: Range | null = null
  lastStartOffset: number = 0
  lastEndOffset: number = 0
  lastRangeText: string = ''
  lastRect: DOMRect | null = null
  private _viewMode: ViewMode = (() => {
    try {
      const saved = localStorage.getItem('blinkora-editor-view-mode');
      return (saved as ViewMode) || "ir";
    } catch {
      return "ir";
    }
  })()

  get viewMode(): ViewMode {
    return this._viewMode;
  }

  set viewMode(mode: ViewMode) {
    this._viewMode = mode;
    try {
      localStorage.setItem('blinkora-editor-view-mode', mode);
    } catch (error) {
      console.warn('Failed to save editor view mode to localStorage:', error);
    }
  }
  lastSelection: Selection | null = null
  vditor: Vditor | null = null
  onChange: ((markdown: string) => void) | null = null
  mode: 'edit' | 'create' | 'comment' = 'edit'
  references: number[] = []
  isShowSearch: boolean = false
  onSend!: (args: OnSendContentType) => Promise<any>
  isFullscreen: boolean = false;
  noteType!: NoteType;
  currentTagLabel: string = ''
  metadata: any = {};

  get showIsEditText() {
    if (this.mode == 'edit') {
      try {
        const local = this.blinkora.editContentStorage.list?.find(i => Number(i.id) == Number(this.blinkora.curSelectedNote?.id))
        if (local && local?.content?.length > 0) {
          return true
        } else {
          return false
        }
      } catch (error) {
        return false
      }
    }
    return false
  }

  reuseServerContent = () => {
    if (this.mode == 'edit') {
      const local = this.blinkora.editContentStorage.list?.find(i => Number(i.id) == Number(this.blinkora.curSelectedNote!.id))
      if (local) {
        this.vditor?.setValue(local.content)
      }
    }
  }

  get canSend() {
    return this.files?.every(i => !i?.uploadPromise?.loading?.value) && (this.files?.length != 0 || this.vditor?.getValue() != '')
  }

  get blinkora() {
    return RootStore.Get(BlinkoraStore)
  }

  handleIOSFocus() {
    try {
      if (helper.env.isIOS() && this.mode == 'edit') {
        this.focus()
      }
    } catch (error) { }
  }

  updateFileOrder = (newFiles: FileType[]) => {
    this.files = newFiles;
  }

  removeFile = (target: FileType) => {
    const targetPath = target.uploadPromise?.value || target.preview;
    this.files = this.files.filter(file => {
      const filePath = file.uploadPromise?.value || file.preview;
      if (targetPath && filePath) return filePath !== targetPath;
      return file.name !== target.name;
    });
  }

  insertMarkdown = (text) => {
    this.vditor?.insertValue(text)
    this.onChange?.(this.vditor?.getValue() ?? '')
    this.focus()
  }

  replaceMarkdown = (text) => {
    this.vditor?.setValue(text)
    this.onChange?.(this.vditor?.getValue() ?? '')
    this.focus()
  }

  getEditorRange = (vditor: IVditor) => {
    let range: Range;
    const element = vditor[vditor.currentMode]!.element;
    if (getSelection()!.rangeCount > 0) {
      range = getSelection()!.getRangeAt(0);
      if (element.isEqualNode(range.startContainer) || element.contains(range.startContainer)) {
        return range;
      }
    }
    if (vditor[vditor.currentMode]!.range) {
      return vditor[vditor.currentMode]!.range;
    }
    element.focus();
    range = element.ownerDocument.createRange();
    range.setStart(element, 0);
    range.collapse(true);
    return range;
  };


  focus = () => {
    this.vditor?.focus();
    const editorElement = getEditorElements(this.viewMode, this.vditor!)
    try {
      const range = document.createRange()
      const selection = window.getSelection()
      const walker = document.createTreeWalker(
        editorElement!,
        NodeFilter.SHOW_TEXT,
        null
      )
      let lastNode: any = null
      while (walker.nextNode()) {
        lastNode = walker.currentNode
      }
      if (lastNode) {
        range.setStart(lastNode, lastNode?.length)
        range.setEnd(lastNode, lastNode?.length)
        selection?.removeAllRanges()
        selection?.addRange(range)
        editorElement!.focus()
      }
    } catch (error) {
    }
  }

  clearMarkdown = () => {
    this.vditor?.setValue('')
    this.onChange?.('')
    this.focus()
  }


  // Get audio duration from file
  getAudioDuration = (file: File): Promise<{ duration: string, durationSeconds: number } | null> => {
    return new Promise((resolve) => {
      if (!file.type.startsWith('audio/')) {
        resolve(null);
        return;
      }

      const audio = new Audio();
      const url = URL.createObjectURL(file);

      audio.addEventListener('loadedmetadata', () => {
        const durationSeconds = Math.floor(audio.duration);
        const minutes = Math.floor(durationSeconds / 60).toString().padStart(2, '0');
        const seconds = Math.floor(durationSeconds % 60).toString().padStart(2, '0');
        const duration = `${minutes}:${seconds}`;

        URL.revokeObjectURL(url);
        resolve({ duration, durationSeconds });
      });

      audio.addEventListener('error', () => {
        URL.revokeObjectURL(url);
        resolve(null);
      });

      audio.src = url;
    });
  }

  uploadFiles = async (acceptedFiles) => {
    const uploadFileType = {}

    const _acceptedFiles = await Promise.all(acceptedFiles.map(async file => {
      const extension = helper.getFileExtension(file.name)
      const previewType = helper.getFileType(file.type, file.name)
      const isUserVoiceRecording = file.isUserVoiceRecording || false
      const isAudioFile = file.type.startsWith('audio/')

      // Get audio duration - either from file properties (user recordings) or by analyzing the file
      let audioDuration = file.audioDuration || null
      let audioDurationSeconds = file.audioDurationSeconds || null

      if (isAudioFile && !audioDuration) {
        const durationInfo = await this.getAudioDuration(file)
        if (durationInfo) {
          audioDuration = durationInfo.duration
          audioDurationSeconds = durationInfo.durationSeconds
        }
      }

      return {
        name: file.name,
        size: file.size,
        previewType,
        extension: extension ?? '',
        preview: URL.createObjectURL(file),
        isUserVoiceRecording,
        audioDuration,
        audioDurationSeconds,
        isAudioFile,
        uploadPromise: new PromiseState({
          function: async () => {
            const formData = new FormData();
            formData.append('file', file)

            // Add metadata for user voice recordings
            if (isUserVoiceRecording) {
              formData.append('isUserVoiceRecording', 'true')
            }

            // Add audio duration for all audio files
            if (audioDuration) {
              formData.append('audioDuration', audioDuration)
            }
            if (audioDurationSeconds) {
              formData.append('audioDurationSeconds', audioDurationSeconds.toString())
            }

            const { onUploadProgress } = RootStore.Get(ToastPlugin)
              .setSizeThreshold(40)
              .uploadProgress(file);

            const response = await axiosInstance.post(getBlinkoraEndpoint('/api/file/upload'), formData, {
              onUploadProgress
            });
            const data = response.data;
            const uploadedFileName = data.fileName ?? data.name;
            const uploadedFilePath = data.filePath ?? data.path;

            if (uploadedFileName) {
              const fileIndex = this.files.findIndex(f => f.name === file.name);
              if (fileIndex !== -1) {
                this.files[fileIndex]!.name = uploadedFileName;
              }
            }

            if (uploadedFilePath) {
              uploadFileType[file.name] = data.type
              return uploadedFilePath
            }
          }
        }),
        type: file.type
      }
    }))
    this.files.push(..._acceptedFiles)
    await Promise.all(_acceptedFiles.map(i => i.uploadPromise.call()))
    if (this.mode == 'create') {
      _acceptedFiles.map(i => ({
        name: i.name,
        path: i.uploadPromise.value,
        type: uploadFileType?.[i.name],
        size: i.size
      })).map(t => {
        RootStore.Get(BlinkoraStore).createAttachmentsStorage.push(t)
      })
    } else {
      _acceptedFiles.map(i => ({
        name: i.name,
        path: i.uploadPromise.value,
        type: uploadFileType?.[i.name],
        size: i.size,
        id: this.blinkora.curSelectedNote?.id!
      })).map(t => {
        RootStore.Get(BlinkoraStore).editAttachmentsStorage.push(t)
      })
    }
  }

  handlePasteFile = ({ fileName, filePath, type, size }: { fileName: string, filePath: string, type: string, size: number }) => {
    const extension = helper.getFileExtension(fileName)
    const previewType = helper.getFileType(type, fileName)
    showTipsDialog({
      title: i18n.t('insert-attachment-or-note'),
      content: i18n.t('paste-to-note-or-attachment'),
      buttonSlot: <>
        <Button variant='flat' className="ml-auto" color='default'
          onPress={e => {
            if (type.includes('image')) {
              this.vditor?.insertValue(`![${fileName}](${filePath})`)
            } else {
              this.vditor?.insertValue(`[${fileName}](${filePath})`)
            }
            this.onChange?.(this.vditor?.getValue() ?? '')
            RootStore.Get(DialogStandaloneStore).close()
          }}>{i18n.t('context')}</Button>
        <Button color='primary' onPress={async e => {
          const _file = {
            name: fileName,
            size,
            previewType: previewType,
            extension: extension ?? '',
            preview: filePath,
            uploadPromise: new PromiseState({
              function: async () => {
                return filePath
              }
            }),
            type: type
          }
          await _file.uploadPromise.call()
          this.files.push(_file)
          const attachment = { name: fileName, path: filePath, type, size }
          if (this.mode == 'create') {
            RootStore.Get(BlinkoraStore).createAttachmentsStorage.push(attachment)
          } else {
            RootStore.Get(BlinkoraStore).editAttachmentsStorage.push({
              ...attachment,
              id: this.blinkora.curSelectedNote?.id!
            })
          }
          RootStore.Get(DialogStandaloneStore).close()
        }}>{i18n.t('attachment')}</Button>
      </>
    })
  }

  // ************************************* reference logic  start ************************************************************************************
  get currentReferences() {
    return this.noteListByIds.value?.slice()?.sort((a, b) => this.references.indexOf(a.id) - this.references.indexOf(b.id))
  }

  noteListByIds = new PromiseState({
    function: async ({ ids }) => {
      return await api.notes.listByIds.mutate({ ids })
    }
  })

  deleteReference = (id: number) => {
    this.references = this.references.filter(i => i != id)
  }

  addReference = (id: number) => {
    if (!this.references.includes(id)) {
      this.references.push(id)
      this.noteListByIds.call({ ids: this.references })
    }
  }

  setIsShowSearch = (show: boolean) => {
    this.isShowSearch = show
  }


  // ************************************* reference logic  end ************************************************************************************

  async handleSend() {
    if (!this.canSend) return;
    try {
      if (this.mode == 'create' && this.currentTagLabel != '') {
        this.vditor?.insertValue(`\n\n${this.currentTagLabel} `)
        this.onChange?.(this.vditor?.getValue() ?? '')
      }
      let content = stripBlinkoraFileAccessTokensFromText(this.vditor?.getValue() ?? '')
      if (!content && this.files?.length) {
        content = this.files.map(i => `[${i.name}](${i.uploadPromise.value})`).join('\n')
      }
      await this.onSend?.({
        content,
        files: this.files.map(i => ({ ...i, uploadPath: i.uploadPromise.value })),
        noteType: this.noteType,
        references: this.references,
        metadata: this.metadata
      });
      this.clearEditor();
      eventBus.emit('editor:setFullScreen', false);
    } catch (error) {
      console.error('Failed to send content:', error);
    }
  }

  clearEditor = () => {
    this.vditor?.setValue('')
    this.files = [];
    this.references = []
    this.metadata = {};
  }

  constructor() {
    makeAutoObservable(this)
  }

  init = (args: Partial<EditorStore>) => {
    Object.assign(this, args)
    //remove listener on pc
    const ir = document.querySelector('.vditor-ir .vditor-reset')
    if (ir) {
      ir.addEventListener('ondragstart', (e) => {
        if (ir.contains(e.target as Node)) {
          e.stopImmediatePropagation();
          e.preventDefault();
        }
      }, true);
    }
  }

  setCallbacks = (
    onChange: ((markdown: string) => void) | undefined,
    onSend: (args: OnSendContentType) => Promise<any>,
  ) => {
    this.onChange = onChange ?? null;
    this.onSend = onSend;
  }

  isShowEditorToolbar(isPc: boolean) {
    const blinkora = RootStore.Get(BlinkoraStore)
    let showToolbar = true
    if (blinkora.config.value?.toolbarVisibility) {
      showToolbar = blinkora.config.value?.toolbarVisibility == 'always-show-toolbar' ? true : (
        blinkora.config.value?.toolbarVisibility == 'hide-toolbar-on-mobile' ?
          (isPc ? true : false)
          : false
      )
    }
    return showToolbar
  }

  adjustMobileEditorHeight = () => {
    const editor = document.getElementsByClassName('vditor-reset')
    try {
      for (let i = 0; i < editor?.length; i++) {
        //@ts-ignore
        const editorHeight = window.innerHeight - 200
        //@ts-ignore
        if (editor[i].style.height > editorHeight) {
          //@ts-ignore
          editor[i].style!.height = `${editorHeight}px`
        }
        //@ts-ignore
        editor[i].style!.maxHeight = `${editorHeight}px`
        // }
      }
    } catch (error) { }
  }

  setFullscreen(value: boolean) {
    this.isFullscreen = value;
    if (value) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'auto';
    }
  }
}
