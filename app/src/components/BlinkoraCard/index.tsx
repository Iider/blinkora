import { observer } from "mobx-react-lite";
import { BlinkoraStore } from '@/store/blinkoraStore';
import { Card } from '@heroui/react';
import { RootStore } from '@/store';
import { ContextMenuTrigger } from '@/components/Common/ContextMenu';
import { Note } from '@shared/lib/types';
import { ShowEditBlinkoraModel } from "../BlinkoraRightClickMenu";
import { useMediaQuery } from "usehooks-ts";
import { _ } from '@/lib/lodash';
import { useEffect, useRef, useState } from "react";
import type React from "react";
import { CardBlogBox } from "./cardBlogBox";
import { NoteContent } from "./noteContent";
import { CardHeader } from "./cardHeader";
import { CardFooter } from "./cardFooter";
import { FocusEditorFixMobile } from "../Common/Editor/editorUtils";
import { SwipeableCard } from "./SwipeableCard";
import { api } from "@/lib/trpc";
import { FullscreenEditor } from "./FullscreenEditor";
import { SimpleCommentList } from "./annotationButton";
import { confirmDeleteNotes } from "@/lib/noteDeletion";
import { findPreviewTitle, shouldUseBlogPreview } from "./cardPreview";
import { CardBack } from "./CardBack";

const TOP_CLICK_MAX_DURATION_MS = 230;
const TOP_CLICK_MAX_MOVE_PX = 6;
const CARD_TOP_ZONE_HEIGHT = 40;
const CARD_FLIP_SWITCH_MS = 125;
const CARD_FLIP_TOTAL_MS = 260;
const CARD_TOP_INTERACTIVE_SELECTOR = [
  '[data-drag-ignore="true"]',
  'a',
  'button',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="button"]',
].join(',');

type FlipPhase = 'idle' | 'out' | 'in';

const getEventTargetElement = (target: EventTarget | null) => {
  if (target instanceof Element) return target;
  if (target instanceof Text) return target.parentElement;
  return null;
};

const isTopInteractiveTarget = (target: EventTarget | null) => {
  return !!getEventTargetElement(target)?.closest(CARD_TOP_INTERACTIVE_SELECTOR);
};

const isEventInTopZone = (e: React.PointerEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>) => {
  const rect = e.currentTarget.getBoundingClientRect();
  return e.clientY - rect.top <= CARD_TOP_ZONE_HEIGHT;
};


export type BlinkoraItem = Note & {
  isBlog?: boolean;
  title?: string;
  originURL?: string;
  isExpand?: boolean;
}

interface BlinkoraCardProps {
  blinkoraItem: BlinkoraItem;
  className?: string;
  forceBlog?: boolean;
  defaultExpanded?: boolean;
  glassEffect?: boolean;
  withoutBoxShadow?: boolean;
}

export const BlinkoraCard = observer(({ blinkoraItem, glassEffect = false, forceBlog = false, withoutBoxShadow = false, className, defaultExpanded = false }: BlinkoraCardProps) => {
  const isPc = useMediaQuery('(min-width: 768px)');
  const blinkora = RootStore.Get(BlinkoraStore);
  const [isFullscreenEditorOpen, setIsFullscreenEditorOpen] = useState(false);
  const [isBackVisible, setIsBackVisible] = useState(false);
  const [flipPhase, setFlipPhase] = useState<FlipPhase>('idle');
  const flipPhaseRef = useRef<FlipPhase>('idle');
  const flipTimerRef = useRef<number[]>([]);
  const topPressRef = useRef<{
    x: number;
    y: number;
    startedAt: number;
    moved: boolean;
  } | null>(null);
  const isSelected = blinkora.curMultiSelectIdSet.has(blinkoraItem.id!);

  // DraggableBlinkoraCard reads this flag to disable sorting while fullscreen editing owns the note.
  blinkoraItem.isExpand = blinkora.fullscreenEditorNoteId === blinkoraItem.id;
  const cardInteractionMode = blinkora.config.value?.cardInteractionMode === 'auto' ? 'auto' : 'article';
  const usesArticlePreview = forceBlog || shouldUseBlogPreview(blinkoraItem.content, blinkora.config.value?.textFoldLength);
  const usesFullscreenInteraction = forceBlog || usesArticlePreview || cardInteractionMode === 'article';

  blinkoraItem.isBlog = usesArticlePreview;
  blinkoraItem.title = findPreviewTitle(blinkoraItem.content, blinkoraItem.title);

  const clearFlipTimers = () => {
    flipTimerRef.current.forEach(timer => window.clearTimeout(timer));
    flipTimerRef.current = [];
  };

  useEffect(() => {
    flipPhaseRef.current = flipPhase;
  }, [flipPhase]);

  useEffect(() => {
    clearFlipTimers();
    setIsBackVisible(false);
    setFlipPhase('idle');
  }, [blinkoraItem.id]);

  useEffect(() => () => clearFlipTimers(), []);

  const toggleCardFace = () => {
    if (flipPhaseRef.current !== 'idle') return;

    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      setIsBackVisible(value => !value);
      return;
    }

    clearFlipTimers();
    setFlipPhase('out');
    flipPhaseRef.current = 'out';

    const switchTimer = window.setTimeout(() => {
      setIsBackVisible(value => !value);
      setFlipPhase('in');
      flipPhaseRef.current = 'in';
    }, CARD_FLIP_SWITCH_MS);

    const doneTimer = window.setTimeout(() => {
      setFlipPhase('idle');
      flipPhaseRef.current = 'idle';
      flipTimerRef.current = [];
    }, CARD_FLIP_TOTAL_MS);

    flipTimerRef.current = [switchTimer, doneTimer];
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isEventInTopZone(e)) {
      e.stopPropagation();
      if (blinkora.isMultiSelectMode && !isTopInteractiveTarget(e.target)) {
        blinkora.onMultiSelectNote(blinkoraItem.id!);
      }
      return;
    }

    if (isBackVisible || flipPhase !== 'idle') return;

    if (blinkora.isMultiSelectMode) {
      blinkora.onMultiSelectNote(blinkoraItem.id!);
    } else if (usesFullscreenInteraction) {
      setIsFullscreenEditorOpen(true);
      blinkora.fullscreenEditorNoteId = blinkoraItem.id!;
    }
  };

  const handleContextMenu = () => {
    blinkora.curSelectedNote = _.cloneDeep(blinkoraItem);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (isEventInTopZone(e as React.MouseEvent<HTMLDivElement>)) return;
    if (usesFullscreenInteraction || isBackVisible || flipPhase !== 'idle') return;
    blinkora.curSelectedNote = _.cloneDeep(blinkoraItem);
    ShowEditBlinkoraModel();
    FocusEditorFixMobile()
  };

  const handleTopPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !isEventInTopZone(e) || isTopInteractiveTarget(e.target)) {
      topPressRef.current = null;
      return;
    }

    topPressRef.current = {
      x: e.clientX,
      y: e.clientY,
      startedAt: Date.now(),
      moved: false,
    };
  };

  const handleTopPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const topPress = topPressRef.current;
    if (!topPress) return;

    const movedX = Math.abs(e.clientX - topPress.x);
    const movedY = Math.abs(e.clientY - topPress.y);
    if (movedX > TOP_CLICK_MAX_MOVE_PX || movedY > TOP_CLICK_MAX_MOVE_PX) {
      topPress.moved = true;
    }
  };

  const handleTopPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const topPress = topPressRef.current;
    topPressRef.current = null;
    if (
      !topPress ||
      topPress.moved ||
      blinkora.isMultiSelectMode ||
      !isEventInTopZone(e) ||
      isTopInteractiveTarget(e.target)
    ) return;

    const duration = Date.now() - topPress.startedAt;
    if (duration > TOP_CLICK_MAX_DURATION_MS) return;

    toggleCardFace();
  };

  const handleSwipePin = () => {
    blinkora.upsertNote.call({
      id: blinkoraItem.id,
      isTop: !blinkoraItem.isTop
    });
  };

  const handleSwipeDelete = () => {
    if (blinkoraItem.isRecycle) {
      confirmDeleteNotes({ ids: [blinkoraItem.id!] });
      return;
    }

    api.notes.trashMany.mutate({ ids: [blinkoraItem.id!] }).then(() => {
      blinkora.updateTicker++;
    });
  };

  return (
    <>
      <FullscreenEditor
        blinkoraItem={blinkoraItem}
        isOpen={isFullscreenEditorOpen}
        onClose={() => setIsFullscreenEditorOpen(false)}
      />

      {(() => {
        const cardContent = (
          <div
            onContextMenu={handleContextMenu}
            onDoubleClick={handleDoubleClick}
            onClick={handleClick}
            onPointerDown={handleTopPointerDown}
            onPointerMove={handleTopPointerMove}
            onPointerUp={handleTopPointerUp}
            className="blinkora-flip-card"
          >
            <Card
              data-note-type-picker-boundary="true"
              onContextMenu={e => !isPc && e.stopPropagation()}
              shadow='none'
              className={`
                blinkora-flip-face ${flipPhase === 'out' ? 'blinkora-card-flip-out' : ''} ${flipPhase === 'in' ? 'blinkora-card-flip-in' : ''}
                flex flex-col p-4 ${glassEffect ? 'bg-transparent' : 'bg-background'} transition-[background-color,box-shadow] duration-150 ease-out group/card
                ${usesFullscreenInteraction && !isBackVisible ? 'cursor-pointer' : ''}
                ${isSelected ? 'ring-2 ring-inset ring-primary/70 bg-primary/5 shadow-sm' : ''}
                ${className}
              `}
            >
              {isBackVisible ? (
                <CardBack
                  blinkoraItem={blinkoraItem}
                  blinkora={blinkora}
                  isExpanded={defaultExpanded}
                />
              ) : (
                <div className="w-full">
                  <CardHeader
                    blinkoraItem={blinkoraItem}
                    blinkora={blinkora}
                    isExpanded={defaultExpanded}
                  />

                  {blinkoraItem.isBlog && (
                    <div data-drag-ignore="true">
                      <CardBlogBox
                        blinkoraItem={blinkoraItem}
                        isExpanded={defaultExpanded}
                        previewLineLimit={blinkora.config.value?.articlePreviewLineLimit}
                      />
                    </div>
                  )}

                  {!blinkoraItem.isBlog && (
                    <div data-drag-ignore="true">
                      <NoteContent blinkoraItem={blinkoraItem} blinkora={blinkora} isExpanded={defaultExpanded} />
                    </div>
                  )}

                  <CardFooter blinkoraItem={blinkoraItem} />
                  {!!blinkoraItem.comments?.length && (
                    <div data-drag-ignore="true">
                      <SimpleCommentList blinkoraItem={blinkoraItem} />
                    </div>
                  )}
                </div>
              )}
            </Card>
          </div>
        );

        const wrappedContent = (
          <ContextMenuTrigger id="blink-item-context-menu">
            {cardContent}
          </ContextMenuTrigger>
        );

        if (!isPc) {
          return (
            <SwipeableCard
              onPin={handleSwipePin}
              onDelete={handleSwipeDelete}
              isPinned={blinkoraItem.isTop}
            >
              {wrappedContent}
            </SwipeableCard>
          );
        }

        return wrappedContent;
      })()}
    </>
  );
});
