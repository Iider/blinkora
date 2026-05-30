import { useState, useRef, useEffect } from 'react';
import { MouseSensor, TouchSensor, useSensor, useSensors, useDroppable, useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { api } from '@/lib/trpc';
import { BlinkoraCard } from '@/components/BlinkoraCard';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/Common/Iconify/icons';
import { RootStore } from '@/store';
import { BlinkoraStore } from '@/store/blinkoraStore';

const TOP_DRAG_ZONE_HEIGHT = 40;
const BOTTOM_DRAG_ZONE_HEIGHT = 56;
const DRAG_IGNORE_SELECTOR = [
  '[data-drag-ignore="true"]',
  'a',
  'button',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="button"]',
].join(',');

const getEventTargetElement = (target: EventTarget | null) => {
  if (target instanceof Element) return target;
  if (target instanceof Text) return target.parentElement;
  return null;
};

const getEventClientY = (event: any) => {
  const nativeEvent = event.nativeEvent;
  if (typeof nativeEvent?.clientY === 'number') return nativeEvent.clientY;

  const touch = nativeEvent?.touches?.[0] ?? nativeEvent?.changedTouches?.[0];
  if (typeof touch?.clientY === 'number') return touch.clientY;

  return null;
};

const isDragStartInHandleZone = (event: any) => {
  const target = getEventTargetElement(event.target);
  const currentTarget = event.currentTarget as HTMLElement | null;
  const clientY = getEventClientY(event);

  if (!target || !currentTarget || clientY == null) return false;
  if (target.closest(DRAG_IGNORE_SELECTOR)) return false;

  const rect = currentTarget.getBoundingClientRect();
  const offsetY = clientY - rect.top;
  return offsetY <= TOP_DRAG_ZONE_HEIGHT || offsetY >= rect.height - BOTTOM_DRAG_ZONE_HEIGHT;
};

const createDragHandleListeners = (listeners: ReturnType<typeof useDraggable>['listeners']) => {
  if (!listeners) return undefined;

  return Object.fromEntries(
    Object.entries(listeners).map(([eventName, handler]) => [
      eventName,
      (event: any) => {
        if (!isDragStartInHandleZone(event)) return;
        (handler as (event: any) => void)(event);
      },
    ]),
  );
};

interface UseDragCardProps {
  notes: any[] | undefined;
  onNotesUpdate?: (notes: any[]) => void;
  activeId: number | null;
  setActiveId: (id: number | null) => void;
  insertPosition: number | null;
  setInsertPosition: (position: number | null) => void;
  isDragForbidden: boolean;
  setIsDragForbidden: (forbidden: boolean) => void;
  isDragEnabled?: boolean;
}

export const useDragCard = ({ notes, onNotesUpdate, activeId, setActiveId, insertPosition, setInsertPosition, isDragForbidden, setIsDragForbidden, isDragEnabled = true }: UseDragCardProps) => {
  const [localNotes, setLocalNotes] = useState<any[]>([]);
  const isDraggingRef = useRef(false);
  const blinkora = RootStore.Get(BlinkoraStore);

  useEffect(() => {
    if (notes && !isDraggingRef.current) {
      const sortedNotes = [...notes].sort((a, b) => {
        if (a.isTop !== b.isTop) {
          return b.isTop ? 1 : -1;
        }
        return a.sortOrder - b.sortOrder;
      });
      setLocalNotes(sortedNotes);
      onNotesUpdate?.(sortedNotes);
    }
    else if (!notes) {
      setLocalNotes([]);
    }
  }, [notes]);

  const shouldEnableDrag = isDragEnabled && blinkora.fullscreenEditorNoteId === null;
  
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: shouldEnableDrag ? {
        delay: 250,
        tolerance: 5,
      } : {
        delay: 999999,
        distance: 999999,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: shouldEnableDrag ? {
        delay: 250,
        tolerance: 5,
      } : {
        delay: 999999,
        distance: 999999,
      },
    })
  );

  const handleDragStart = (event: any) => {
    const blinkora = RootStore.Get(BlinkoraStore);
    if (!isDragEnabled || blinkora.fullscreenEditorNoteId !== null) {
      return;
    }
    
    setActiveId(event.active.id as number);
    isDraggingRef.current = true;
  };

  const handleDragEnd = (event: any) => {
    const { active, over } = event;
    isDraggingRef.current = false;

    if (over) {
      const dropTargetId = over.id.toString();
      const dragItemId = active.id;
      const targetNoteId = parseInt(dropTargetId.replace('drop-', ''));

      if (dragItemId !== targetNoteId) {
        const oldIndex = localNotes.findIndex((note) => note.id === dragItemId);
        const newIndex = localNotes.findIndex((note) => note.id === targetNoteId);

        if (oldIndex !== -1 && newIndex !== -1) {
          const movedNote = localNotes[oldIndex];
          const targetNote = localNotes[newIndex];

          // Prevent dragging between pinned and unpinned areas
          if (movedNote.isTop !== targetNote.isTop) {
            setActiveId(null);
            setInsertPosition(null);
            return;
          }

          const newNotes = [...localNotes];
          newNotes.splice(oldIndex, 1);
          newNotes.splice(newIndex, 0, movedNote);

          const updatedNotes = newNotes.map((note, index) => ({
            ...note,
            sortOrder: index,
          }));

          setLocalNotes(updatedNotes);

          const updates = updatedNotes.map((note) => ({
            id: note.id,
            sortOrder: note.sortOrder,
          }));

          api.notes.updateNotesOrder.mutate({ updates });
        }
      }
    }

    setActiveId(null);
    setInsertPosition(null);
    setIsDragForbidden(false);
  };

  const handleDragOver = (event: any) => {
    const { active, over } = event;
    if (over && active) {
      const targetNoteId = parseInt(over.id.toString().replace('drop-', ''));
      const dragItemId = active.id;
      
      setInsertPosition(targetNoteId);
      
      const draggedNote = localNotes.find((note) => note.id === dragItemId);
      const targetNote = localNotes.find((note) => note.id === targetNoteId);
      
      if (draggedNote && targetNote && draggedNote.isTop !== targetNote.isTop) {
        setIsDragForbidden(true);
      } else {
        setIsDragForbidden(false);
      }
    }
  };

  return {
    localNotes,
    sensors,
    setLocalNotes,
    isDraggingRef,
    handleDragStart,
    handleDragEnd,
    handleDragOver
  };
};

interface DraggableBlinkoraCardProps {
  blinkoraItem: any;
  showInsertLine?: boolean;
  insertPosition?: 'top' | 'bottom';
  isDragForbidden?: boolean;
  isDragEnabled?: boolean;
}

export const DraggableBlinkoraCard = ({ blinkoraItem, showInsertLine, insertPosition, isDragForbidden, isDragEnabled = true }: DraggableBlinkoraCardProps) => {
  const { t } = useTranslation()
  const canDrag = isDragEnabled && !blinkoraItem.isExpand;
  
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: `drop-${blinkoraItem.id}`,
    disabled: !isDragEnabled,
  });

  const {
    listeners,
    setNodeRef: setDraggableRef,
    transform,
    isDragging,
  } = useDraggable({
    id: blinkoraItem.id,
    disabled: !canDrag,
  });

  const dragStyle = {
    transform: CSS.Transform.toString(transform),
  };
  const dragHandleListeners = canDrag ? createDragHandleListeners(listeners) : undefined;

  return (
    <div className="relative">
      {showInsertLine && insertPosition === 'top' && (
        <div className={`absolute -top-2 left-0 right-0 h-1 z-50 rounded-full ${isDragForbidden ? 'bg-red-500' : 'bg-blue-500'}`} />
      )}

      <div
        ref={setDroppableRef}
        className={`relative
          ${isDragging ? 'bg-gray-100 dark:bg-gray-800 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg' : ''}
          ${isOver && isDragForbidden ? 'border-2 border-dashed !border-red-500 rounded-lg' : ''}
        `}
      >
        {isOver && isDragForbidden && !isDragging && (
          <div className="absolute inset-0 flex items-center justify-center z-50 bg-red-500/10 rounded-lg">
            <div className="bg-red-500 text-white rounded-full p-3">
              <Icon icon="ph:prohibit-bold" width="32" height="32" />
            </div>
          </div>
        )}
        {isDragging ? (
          <div className="flex items-center justify-center p-8 min-h-[100px]">
            <div className="text-gray-400 text-center">
              <div className="text-sm">{t('dragging')}</div>
            </div>
          </div>
        ) : (
          <div
            ref={setDraggableRef}
            style={dragStyle}
            className="relative !cursor-default group/drag-card"
            {...dragHandleListeners}
          >
            <BlinkoraCard blinkoraItem={blinkoraItem} />
          </div>
        )}
      </div>

      {showInsertLine && insertPosition === 'bottom' && (
        <div className={`absolute -bottom-2 left-0 right-0 h-1 z-50 rounded-full ${isDragForbidden ? 'bg-red-500' : 'bg-blue-500'}`} />
      )}
    </div>
  );
};
