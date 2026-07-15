import { useEffect, useRef } from 'react';
import { Swiper, SwiperSlide, } from "swiper/react";
import "swiper/css";
import "swiper/css/effect-cards";
import { EffectCards, Virtual } from 'swiper/modules';
import 'swiper/css/virtual';
import '../styles/swiper-cards.css';
import { observer } from 'mobx-react-lite';
import { RootStore } from '@/store';
import { BlinkoraStore } from '@/store/blinkoraStore';
import { MarkdownRender } from '@/components/Common/MarkdownRender';
import dayjs from '@/lib/dayjs';
import { NoteType } from '@shared/lib/types';
import { Icon } from '@/components/Common/Iconify/icons';
import { useTranslation } from 'react-i18next';
import { Button, Tooltip } from '@heroui/react';
import { LightningIcon, NotesIcon } from '@/components/Common/Icons';
import { PromiseCall } from '@/store/standard/PromiseState';
import { api } from '@/lib/trpc';
import confetti from 'canvas-confetti';
import { useMediaQuery } from 'usehooks-ts';
import { FilesAttachmentRender } from '@/components/Common/AttachmentRender';
import { ScrollArea } from '@/components/Common/ScrollArea';
import { confirmDeleteNotes } from '@/lib/noteDeletion';
import { DialogStore } from '@/store/module/Dialog';
import { BlinkoraEditor } from '@/components/BlinkoraEditor';
import { FocusEditorFixMobile } from '@/components/Common/Editor/editorUtils';
import { hasLeadingMarkdownHeading } from '@/components/BlinkoraCard/cardPreview';
const App = observer(() => {
  const blinkora = RootStore.Get(BlinkoraStore)
  const swiperRef = useRef(null);
  const { t } = useTranslation()
  const isPc = useMediaQuery('(min-width: 768px)')
  const store = RootStore.Local(() => ({
    currentIndex: 0,
    get currentNote() {
      return store.isRandomReviewMode
        ? blinkora.randomReviewNoteList.value?.[store.currentIndex] ?? null
        : blinkora.dailyReviewNoteList.value?.[store.currentIndex] ?? null
    },
    handleSlideChange: async (_swiper) => {
      store.currentIndex = _swiper.activeIndex
    },
    isRandomReviewMode: false,
    get isBlinkora() {
      return store.currentNote?.type == NoteType.BLINKORA
    }
  }))

  useEffect(() => {
    if (!store.isRandomReviewMode && blinkora.dailyReviewNoteList.value?.length == 0) {
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6, x: isPc ? 0.6 : 0.5 }
      });
    }
  }, [blinkora.dailyReviewNoteList.value, blinkora.randomReviewNoteList.value, store.isRandomReviewMode])

  const reviewNotes = store.isRandomReviewMode
    ? blinkora.randomReviewNoteList.value ?? []
    : blinkora.dailyReviewNoteList.value ?? []

  const refreshReviewNotes = async () => {
    if (store.isRandomReviewMode) {
      await blinkora.randomReviewNoteList.call({ limit: 30 })
    } else {
      await blinkora.dailyReviewNoteList.call()
    }
  }

  const openCurrentNoteEditor = () => {
    if (!store.currentNote) return
    const note = store.currentNote
    blinkora.curSelectedNote = {
      ...note,
      attachments: note.attachments ? [...note.attachments] : [],
      references: note.references ? [...note.references] : []
    }
    RootStore.Get(DialogStore).setData({
      isOpen: true,
      onlyContent: true,
      isDismissable: false,
      showOnlyContentCloseButton: true,
      size: '5xl',
      content: (
        <BlinkoraEditor
          isInDialog
          mode="edit"
          key={`review-editor-${note.id}`}
          onSended={async () => {
            RootStore.Get(DialogStore).close()
            blinkora.isCreateMode = false
            await refreshReviewNotes()
          }}
        />
      )
    })
    FocusEditorFixMobile()
  }

  return (
    <ScrollArea fixMobileTopBar className="App h-full overflow-hidden mt-2">
      <div className="flex justify-center mb-2">
        <Button
          color={store.isRandomReviewMode ? "primary" : "default"}
          variant={store.isRandomReviewMode ? "solid" : "flat"}
          className="text-sm"
          startContent={<Icon icon="tabler:cards" width="16" height="16" />}
          onPress={() => {
            store.isRandomReviewMode = !store.isRandomReviewMode
            if (store.isRandomReviewMode) {
              blinkora.randomReviewNoteList.call({ limit: 30 })
            } else {
              blinkora.dailyReviewNoteList.call()
            }
          }}
        >
          {t('random-mode')}
        </Button>
        
        {store.isRandomReviewMode && (
          <Button
            className="ml-2 text-sm"
            isIconOnly
            onPress={() => {
              blinkora.randomReviewNoteList.call({ limit: 30 });
            }}
          >
            <Icon icon="fluent:arrow-sync-24-filled" width="16" height="16" className="hover:rotate-180 !transition-all" />
          </Button>
        )}
      </div>

      {
        reviewNotes.length != 0 && <>
          <Swiper
            onSwiper={(swiper) => {
              //@ts-ignore
              swiperRef.current = swiper;
            }}
            onSlideChange={(swiper) => store.handleSlideChange(swiper)}
            effect={"cards"}
            grabCursor={true}
            modules={[EffectCards, Virtual]}
            className="mt-5 md:mt-4 w-[300px] h-[calc(100vh_-_300px)] md:w-[550px] "
            allowSlideNext={true}
            allowSlidePrev={true}
            touchRatio={1}
            resistance={true}
            resistanceRatio={0.5}
            centeredSlides={true}
            virtual={{
              enabled: true,
              slides: reviewNotes,
              cache: true,
              addSlidesBefore: 1,
              addSlidesAfter: 1,
            }}
          >
            {
              reviewNotes.map((i, index) => (
                <SwiperSlide key={i.id} virtualIndex={index} data-id={i.id} className='bg-background shadow-lg p-4 w-full overflow-hidden h-full'>
                  <div className='bg-background p-0 w-full overflow-y-scroll h-full'>
                    <div className='flex items-center gap-2 mb-2'>
                      <div className='text-xs text-desc'>{dayjs(i.createdAt).fromNow()}</div>
                      {
                        store.isBlinkora ?
                          <div className='flex items-center justify-start ml-auto'>
                            <Icon className='text-yellow-500' icon="basil:lightning-solid" width="12" height="12" />
                            <div className='text-desc text-xs font-bold ml-1'>{t('blinkora')}</div>
                          </div> :
                          <div className='flex items-center justify-start  ml-auto'>
                            <Icon className='text-blue-500' icon="solar:notes-minimalistic-bold-duotone" width="12" height="12" />
                            <div className='text-desc text-xs font-bold ml-1'>{t('note')}</div>
                          </div>
                      }
                    </div>
                    <div className={`blinkora-card-markdown blinkora-review-card-markdown ${hasLeadingMarkdownHeading(i.content) ? 'blinkora-card-markdown-has-title' : ''}`}>
                      <MarkdownRender content={i.content} onChange={(newContent) => {
                        i.content = newContent
                        blinkora.upsertNote.call({ id: i.id, content: newContent, refresh: false })
                      }} />
                    </div>
                    <div className={i.attachments?.length != 0 ? 'my-2' : ''}>
                      <FilesAttachmentRender columns={2} files={i.attachments ?? []} preview />
                    </div>
                  </div>
                </SwiperSlide>
              ))
            }
          </Swiper>

          <div className="mt-8 flex items-center justify-center px-6 gap-4">
            {
              !store.isRandomReviewMode &&
              <Tooltip content={t('reviewed')}>
                <Button onPress={async e => {
                  if (!store.currentNote) return
                  PromiseCall(api.notes.reviewNote.mutate({ id: store.currentNote!.id! }))
                }} isIconOnly color='primary' aria-label={t('reviewed')} startContent={<Icon icon="ci:check-all" width="24" height="24" />} />
              </Tooltip>
            }
            <Tooltip content={store.isBlinkora ? t('convert-to-note') : t('convert-to-blinkora')}>
              <Button isIconOnly onPress={async e => {
                if (!store.currentNote) return
                await blinkora.upsertNote.call({ id: store.currentNote.id, type: store.isBlinkora ? NoteType.NOTE : NoteType.BLINKORA })
                await api.notes.reviewNote.mutate({ id: store.currentNote!.id! })
                await blinkora.dailyReviewNoteList.call()
              }}
                color='default'
                aria-label={store.isBlinkora ? t('convert-to-note') : t('convert-to-blinkora')}
                startContent={store.isBlinkora ? <NotesIcon /> : <LightningIcon />}>
              </Button>
            </Tooltip>

            <Tooltip content={t('edit')} >
              <Button onPress={openCurrentNoteEditor} isIconOnly color='default' aria-label={t('edit')} startContent={<Icon icon="tabler:edit" width="20" height="20" />}></Button>
            </Tooltip>


            <Tooltip content={t('archive')} >
              <Button onPress={async e => {
                if (!store.currentNote) return
                await blinkora.upsertNote.call({ id: store.currentNote.id, isArchived: true })
                await blinkora.dailyReviewNoteList.call()
              }} isIconOnly color='default' aria-label={t('archive')} startContent={<Icon icon="eva:archive-outline" width="20" height="20" />}></Button>
            </Tooltip>

            <Button
              onPress={async e => {
                if (!store.currentNote) return
                confirmDeleteNotes({ ids: [store.currentNote.id!], onDeleted: () => blinkora.dailyReviewNoteList.call() })
              }} isIconOnly color='danger' aria-label={t('delete')} startContent={<Icon icon="mingcute:delete-2-line" width="20" height="20" />}></Button>
          </div>
        </>
      }

      {reviewNotes.length == 0 && <div className='select-none text-ignore flex items-center justify-center gap-2 w-full mt-2 md:mt-10'>
        <Icon icon="line-md:coffee-half-empty-twotone-loop" width="24" height="24" />
        <div className='text-md text-ignore font-bold'>{t('congratulations-youve-reviewed-everything-today')}</div>
      </div>}
    </ScrollArea>

  );
})

export default App;
