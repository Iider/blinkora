import { observer } from "mobx-react-lite"
import Editor from "../Common/Editor"
import { RootStore } from "@/store"
import { BlinkoraStore } from "@/store/blinkoraStore"
import dayjs from "@/lib/dayjs"
import { useEffect, useRef } from "react"
import { NoteType } from "@shared/lib/types"
import { useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { useTranslation } from 'react-i18next'

type IProps = {
  mode: 'create' | 'edit',
  onSended?: () => void,
  onHeightChange?: (height: number) => void,
  height?: number,
  isInDialog?: boolean,
  withoutOutline?: boolean,
  initialData?: { file?: File, text?: string },
  showTopToolbar?: boolean,
  initialNoteType?: NoteType,
}

export const BlinkoraEditor = observer(({ mode, onSended, onHeightChange, isInDialog, withoutOutline, initialData, showTopToolbar = false, initialNoteType }: IProps) => {
  const { t } = useTranslation();
  const isCreateMode = mode == 'create'
  const blinkora = RootStore.Get(BlinkoraStore)
  const editorRef = useRef<any>(null)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const location = useLocation()

  const navigateToCreatedTypePage = async (noteType: NoteType) => {
    const currentPath = searchParams.get('path')

    if (noteType === NoteType.NOTE) {
      if (currentPath !== 'notes') {
        await navigate('/?path=notes')
        blinkora.forceQuery++
      }
      return
    }

    if (noteType === NoteType.TODO) {
      if (currentPath !== 'todo') {
        await navigate('/?path=todo')
        blinkora.forceQuery++
      }
      return
    }

    if (location.pathname !== '/' || currentPath) {
      await navigate('/')
      blinkora.forceQuery++
    }
  }

  const store = RootStore.Local(() => ({
    get noteContent() {
      if (isCreateMode) {
        try {
          const local = blinkora.createContentStorage.value
          const blinkoraContent = blinkora.noteContent
          return local?.content != '' ? local?.content : blinkoraContent
        } catch (error) {
          return ''
        }
      } else {
        try {
          if (!blinkora.curSelectedNote) return '';
          const local = blinkora.editContentStorage.list?.find(i => Number(i.id) == Number(blinkora.curSelectedNote!.id))
          const blinkoraContent = blinkora.curSelectedNote?.content ?? ''
          return local?.content != '' ? (local?.content ?? blinkoraContent) : blinkoraContent
        } catch (error) {
          return ''
        }
      }
    },
    set noteContent(v: string) {
      if (isCreateMode) {
        try {
          blinkora.noteContent = v
          blinkora.createContentStorage.save({ content: v })
        } catch (error) {
          console.error(error)
        }
      } else {
        try {
          if (!blinkora.curSelectedNote) return;
          blinkora.curSelectedNote.content = v
          const hasLocal = blinkora.editContentStorage.list?.find(i => Number(i.id) == Number(blinkora.curSelectedNote!.id))
          if (hasLocal) {
            hasLocal.content = v
            blinkora.editContentStorage.save()
          } else {
            blinkora.editContentStorage.push({ content: v, id: Number(blinkora.curSelectedNote!.id) })
          }
        } catch (error) {
          console.error(error)
        }
      }
    },
    get files(): any {
      if (mode == 'create') {
        const attachments = blinkora.createAttachmentsStorage.list
        if (attachments.length) {
          return (attachments)
        } else {
          return []
        }
      } else {
        const noteId = Number(blinkora.curSelectedNote?.id)
        const currentAttachments = (blinkora.curSelectedNote?.attachments ?? [])
          .map(attachment => ({ ...attachment, attachedToNote: true }))
        const editingAttachments = blinkora.editAttachmentsStorage.list.filter(i => Number(i.id) == noteId)
        const currentPaths = new Set(currentAttachments.map(i => i.path))
        return [
          ...currentAttachments,
          ...editingAttachments
            .filter(i => !currentPaths.has(i.path))
            .map(attachment => ({ ...attachment, attachedToNote: false }))
        ]
      }
    }
  }))

  useEffect(() => {
    blinkora.isCreateMode = mode == 'create'
    if (mode == 'create') {
      if (isInDialog) {
        document.documentElement.style.setProperty('--min-editor-height', `50vh`)
      }
      const local = blinkora.createContentStorage.value
      if (local && local.content != '') {
        blinkora.noteContent = local.content
      }
    } else {
      document.documentElement.style.setProperty('--min-editor-height', `unset`)
      try {
        if (!blinkora.curSelectedNote) return;
        const local = blinkora.editContentStorage.list?.find(i => Number(i.id) == Number(blinkora.curSelectedNote!.id))
        if (local && local?.content != '') {
          blinkora.curSelectedNote.content = local.content
        }
      } catch (error) {
        console.error(error)
      }
    }
  }, [mode])

  return <div className={`h-full flex flex-col ${withoutOutline ? '' : ''}`} ref={editorRef} id='global-editor' onClick={() => {
    blinkora.isCreateMode = mode == 'create'
  }}>
    <Editor
      mode={mode}
      originFiles={store.files}
      originReference={!isCreateMode ? blinkora.curSelectedNote?.references?.map(i => i.toNoteId) : []}
      content={store.noteContent}
      onChange={v => {
        store.noteContent = v
      }}
      withoutOutline={withoutOutline}
      initialData={initialData}
      showTopToolbar={showTopToolbar}
      initialNoteType={initialNoteType}
      onHeightChange={() => {
        onHeightChange?.(editorRef.current?.clientHeight ?? 75)
        if (editorRef.current) {
          const editorElement = document.getElementById('global-editor');
          if (editorElement && editorElement.children[0]) {
            //@ts-ignore
            editorElement.__storeInstance = editorElement.children[0].__storeInstance;
          }
        }
      }}
      isSendLoading={blinkora.upsertNote.loading.value}
      bottomSlot={
        isCreateMode ? <div className='text-xs text-ignore ml-2'>{t('drop-to-upload')}</div> :
          blinkora.curSelectedNote?.createdAt ? <div className='text-xs text-desc'>{dayjs(blinkora.curSelectedNote.createdAt).format("YYYY-MM-DD hh:mm:ss")}</div> : null
      }
      onSend={async ({ content, files, deletedAttachmentPaths, references, noteType, metadata }) => {
        if (isCreateMode) {
          //@ts-ignore
          await blinkora.upsertNote.call({ type: noteType, references, refresh: false, content, attachments: files.map(i => { return { name: i.name, path: i.uploadPath, size: i.size, type: i.type } }), metadata })
          blinkora.createAttachmentsStorage.clear()
          blinkora.createContentStorage.clear()
          await navigateToCreatedTypePage(noteType)
          blinkora.updateTicker++
        } else {
          if (!blinkora.curSelectedNote) return;
          const updatedNote = await blinkora.upsertNote.call({
            id: blinkora.curSelectedNote.id,
            type: noteType,
            //@ts-ignore
            content,
            //@ts-ignore
            attachments: files.map(i => { return { name: i.name, path: i.uploadPath, size: i.size, type: i.type } }),
            deletedAttachmentPaths,
            references,
            metadata,
            refresh: true // Ensure list is refreshed after update
          })
          blinkora.curSelectedNote.content = content
          blinkora.curSelectedNote.attachments = updatedNote.attachments ?? []
          try {
            const noteId = Number(blinkora.curSelectedNote.id)
            blinkora.editAttachmentsStorage.save(blinkora.editAttachmentsStorage.list.filter(i => Number(i.id) !== noteId))
            blinkora.editContentStorage.save(blinkora.editContentStorage.list.filter(i => Number(i.id) !== noteId))
          } catch (error) {
            console.error(error)
          }
        }
        onSended?.()
      }} />
  </div>
})
