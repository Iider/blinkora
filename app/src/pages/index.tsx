import { BlinkoraStore } from '@/store/blinkoraStore';
import { observer } from 'mobx-react-lite';
import Masonry from 'react-masonry-css';
import { useTranslation } from 'react-i18next';
import { RootStore } from '@/store';
import { BlinkoraEditor } from '@/components/BlinkoraEditor';
import { ScrollArea } from '@/components/Common/ScrollArea';
import { BlinkoraCard } from '@/components/BlinkoraCard';
import { useMediaQuery } from 'usehooks-ts';
import { BlinkoraAddButton } from '@/components/BlinkoraAddButton';
import { LoadingAndEmpty } from '@/components/Common/LoadingAndEmpty';
import { Pagination } from '@heroui/react';
import { useSearchParams, useLocation } from 'react-router-dom';
import { useMemo, useState, useEffect, useRef } from 'react';
import dayjs from '@/lib/dayjs';
import { NoteType } from '@shared/lib/types';
import { Icon } from '@/components/Common/Iconify/icons';
import { DndContext, closestCenter, DragOverlay } from '@dnd-kit/core';
import { useDragCard, DraggableBlinkoraCard } from '@/hooks/useDragCard';
import { NoteLoadMode } from '@/store/standard/PromiseState';
import type { ScrollAreaHandles } from '@/components/Common/ScrollArea';

interface TodoGroup {
  displayDate: string;
  todos: any[];
}

const Home = observer(() => {
  const { t } = useTranslation();
  const isPc = useMediaQuery('(min-width: 768px)')
  const blinkora = RootStore.Get(BlinkoraStore)
  blinkora.use()
  blinkora.useQuery();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const isTodoView = searchParams.get('path') === 'todo';
  const isNotesView = searchParams.get('path') === 'notes';
  const isArchivedView = searchParams.get('path') === 'archived';
  const isTrashView = searchParams.get('path') === 'trash';
  const isAllView = searchParams.get('path') === 'all';
  const [activeId, setActiveId] = useState<number | null>(null);
  const [insertPosition, setInsertPosition] = useState<number | null>(null);
  const [isDragForbidden, setIsDragForbidden] = useState<boolean>(false);
  const scrollAreaRef = useRef<ScrollAreaHandles>(null);
  const isCardDragEnabled = isPc && !isTodoView;
  const isPaginationMode = NoteLoadMode.value === 'pagination';

  const currentListState = useMemo(() => {
    if (isNotesView) {
      return blinkora.noteOnlyList;
    } else if (isTodoView) {
      return blinkora.todoList;
    } else if (isArchivedView) {
      return blinkora.archivedList;
    } else if (isTrashView) {
      return blinkora.trashList;
    } else if (isAllView) {
      return blinkora.noteList;
    } else {
      return blinkora.blinkoraList;
    }
  }, [isNotesView, isTodoView, isArchivedView, isTrashView, isAllView, blinkora]);

  // Use drag card hook only for non-todo views
  const { localNotes, sensors, setLocalNotes, handleDragStart, handleDragEnd, handleDragOver } = useDragCard({
    notes: isTodoView ? undefined : currentListState.value,
    activeId,
    setActiveId,
    insertPosition,
    setInsertPosition,
    isDragForbidden,
    setIsDragForbidden,
    isDragEnabled: isCardDragEnabled
  });

  const store = RootStore.Local(() => ({
    editorHeight: 30,
    get showEditor() {
      return !blinkora.noteListFilterConfig.isArchived && !blinkora.noteListFilterConfig.isRecycle
    }
  }))

  const todosByDate = useMemo(() => {
    if (!isTodoView || !currentListState.value) return {} as Record<string, TodoGroup>;
    const todoItems = currentListState.value;
    const groupedTodos: Record<string, TodoGroup> = {};
    todoItems.forEach(todo => {
      const date = dayjs(todo.createdAt).format('YYYY-MM-DD');
      const isToday = dayjs().isSame(dayjs(todo.createdAt), 'day');
      const isYesterday = dayjs().subtract(1, 'day').isSame(dayjs(todo.createdAt), 'day');
      let displayDate;
      if (isToday) {
        displayDate = t('today');
      } else if (isYesterday) {
        displayDate = t('yesterday');
      } else {
        displayDate = dayjs(todo.createdAt).format('MM/DD (ddd)');
      }
      if (!groupedTodos[date]) {
        groupedTodos[date] = {
          displayDate,
          todos: []
        };
      }
      groupedTodos[date].todos.push(todo);
    });
    return Object.entries(groupedTodos)
      .sort(([dateA], [dateB]) => new Date(dateB).getTime() - new Date(dateA).getTime())
      .reduce((acc, [date, data]) => {
        acc[date] = data;
        return acc;
      }, {} as Record<string, TodoGroup>);
  }, [currentListState.value, isTodoView, t]);

  // Restore scroll position when returning from editor
  useEffect(() => {
    const savedPosition = sessionStorage.getItem('restore-scroll-position');
    if (savedPosition && scrollAreaRef.current) {
      const position = Number(savedPosition);
      setTimeout(() => {
        if (scrollAreaRef.current) {
          scrollAreaRef.current.scrollTo(position);
        }
        // Clear the saved position after restoring
        sessionStorage.removeItem('restore-scroll-position');
      }, 100);
    }
  }, [location.key]);

  useEffect(() => {
    const requestedPage = Math.max(1, Number(searchParams.get('page') || 1) || 1);
    const isOutOfRangePage = isPaginationMode
      && requestedPage > 1
      && !currentListState.isLoading
      && currentListState.totalPages > 0
      && requestedPage > currentListState.totalPages;

    if (!isOutOfRangePage) return;

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete('page');
    setSearchParams(nextSearchParams, { replace: true });
  }, [
    isPaginationMode,
    searchParams,
    setSearchParams,
    currentListState,
    currentListState.isLoading,
    currentListState.totalPages
  ]);

  return (
    <div
      style={{
        maxWidth: blinkora.config.value?.maxHomePageWidth ? `${blinkora.config.value?.maxHomePageWidth}px` : '100%'
      }}
      className={`pt-1 md:p-0 relative h-full flex flex-col-reverse md:flex-col mx-auto w-full`}>

      {store.showEditor && isPc && !blinkora.config.value?.hidePcEditor && <div className='px-2 md:px-6' >
        <BlinkoraEditor mode='create' key='create-key' onHeightChange={height => {
          if (!isPc) return
          store.editorHeight = height
        }} />
      </div>}
      {(!isPc || blinkora.config.value?.hidePcEditor) && <BlinkoraAddButton />}

      <LoadingAndEmpty
        isLoading={currentListState.isLoading}
        isEmpty={currentListState.isEmpty}
      />

      {
        !currentListState.isEmpty &&
        <ScrollArea
          ref={scrollAreaRef}
          fixMobileTopBar
          onRefresh={async () => {
            if (isPaginationMode) {
              await currentListState.setPageAndCall(currentListState.page, {})
            } else {
              await currentListState.resetAndCall({})
            }
          }}
          onBottom={isPaginationMode ? undefined : () => {
            blinkora.onBottom();
          }}
          style={{ height: store.showEditor ? `calc(100% - ${(isPc ? (!store.showEditor ? store.editorHeight : 10) : 0)}px)` : '100%' }}
          className={`px-2 mt-0 md:${blinkora.config.value?.hidePcEditor ? 'mt-0' : 'mt-4'} md:px-6 w-full h-full !transition-all scroll-area`}>

          {isTodoView ? (
            <div className="timeline-view relative">
              {Object.entries(todosByDate).map(([date, { displayDate, todos }]) => (
                <div key={date} className="mb-6 relative">
                  <div className="flex items-center mb-2 relative z-10">
                    <div className="w-4 h-4 rounded-sm bg-primary absolute left-[4.5px] transform translate-x-[-50%]"></div>
                    <h3 className="text-base font-bold ml-5">{displayDate}</h3>
                  </div>
                  <div className="md:pl-4">
                    {todos.map(todo => (
                      <div key={todo.id} className="mb-3">
                        <BlinkoraCard blinkoraItem={todo} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {Object.keys(todosByDate).length === 0 && (
                <div className="text-center py-8 text-gray-500">
                  <Icon icon="mdi:clipboard-text-outline" width="48" height="48" className="mx-auto mb-2 opacity-50" />
                  <p>{t('no-data-here-well-then-time-to-write-a-note')}</p>
                </div>
              )}
            </div>
          ) : (
            <>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
              >
                <Masonry
                  breakpointCols={{
                    default: blinkora.config?.value?.largeDeviceCardColumns ? Number(blinkora.config?.value?.largeDeviceCardColumns) : 2,
                    1280: blinkora.config?.value?.mediumDeviceCardColumns ? Number(blinkora.config?.value?.mediumDeviceCardColumns) : 2,
                    768: blinkora.config?.value?.smallDeviceCardColumns ? Number(blinkora.config?.value?.smallDeviceCardColumns) : 1
                  }}
                  className="card-masonry-grid"
                  columnClassName="card-masonry-grid_column">
                  {
                    localNotes?.map((i, index) => {
                      const showInsertLine = insertPosition === i.id && activeId !== i.id;
                      return (
                        <DraggableBlinkoraCard
                          key={i.id}
                          blinkoraItem={i}
                          showInsertLine={showInsertLine}
                          insertPosition="top"
                          isDragForbidden={isDragForbidden && showInsertLine}
                          isDragEnabled={isCardDragEnabled}
                        />
                      );
                    })
                  }
                </Masonry>
                <DragOverlay>
                  {activeId ? (
                    <div className="rotate-3 scale-105 opacity-90 max-w-sm shadow-xl">
                      <BlinkoraCard
                        blinkoraItem={localNotes.find(n => n.id === activeId)}
                      />
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            </>
          )}

          {isPaginationMode && currentListState.totalPages > 1 && (
            <div className="flex justify-center w-full my-5">
              <Pagination
                showControls
                size="sm"
                total={currentListState.totalPages}
                page={currentListState.page}
                onChange={(page) => {
                  const nextSearchParams = new URLSearchParams(searchParams);
                  if (page <= 1) {
                    nextSearchParams.delete('page');
                  } else {
                    nextSearchParams.set('page', String(page));
                  }
                  setSearchParams(nextSearchParams);
                  scrollAreaRef.current?.scrollTo(0);
                }}
              />
            </div>
          )}
          {!isPaginationMode && currentListState.isLoadAll && <div className='select-none w-full text-center text-sm font-bold text-ignore my-4'>{t('all-notes-have-been-loaded', { items: currentListState.value?.length })}</div>}
        </ScrollArea>
      }
    </div>
  );
});

export default Home;
