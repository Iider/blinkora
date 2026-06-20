import { observer } from "mobx-react-lite";
import { BlinkoraStore } from '@/store/blinkoraStore';
import { Card } from '@heroui/react';
import { RootStore } from '@/store';
import { ContextMenuTrigger } from '@/components/Common/ContextMenu';
import { Note } from '@shared/lib/types';
import { ShowEditBlinkoraModel } from "../BlinkoraRightClickMenu";
import { useMediaQuery } from "usehooks-ts";
import { _ } from '@/lib/lodash';
import { useState } from "react";
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
  const isSelected = blinkora.curMultiSelectIdSet.has(blinkoraItem.id!);

  // DraggableBlinkoraCard reads this flag to disable sorting while fullscreen editing owns the note.
  blinkoraItem.isExpand = blinkora.fullscreenEditorNoteId === blinkoraItem.id;
  const cardInteractionMode = blinkora.config.value?.cardInteractionMode === 'auto' ? 'auto' : 'article';
  const usesArticlePreview = forceBlog || shouldUseBlogPreview(blinkoraItem.content, blinkora.config.value?.textFoldLength);
  const usesFullscreenInteraction = forceBlog || usesArticlePreview || cardInteractionMode === 'article';

  blinkoraItem.isBlog = usesArticlePreview;
  blinkoraItem.title = findPreviewTitle(blinkoraItem.content, blinkoraItem.title);


  const handleClick = () => {
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
    if (usesFullscreenInteraction) return;
    blinkora.curSelectedNote = _.cloneDeep(blinkoraItem);
    ShowEditBlinkoraModel();
    FocusEditorFixMobile()
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
          >
            <Card
              data-note-type-picker-boundary="true"
              onContextMenu={e => !isPc && e.stopPropagation()}
              shadow='none'
              className={`
                flex flex-col p-4 ${glassEffect ? 'bg-transparent' : 'bg-background'} transition-[background-color,box-shadow] duration-150 ease-out group/card
                ${usesFullscreenInteraction ? 'cursor-pointer' : ''}
                ${isSelected ? 'ring-2 ring-inset ring-primary/70 bg-primary/5 shadow-sm' : ''}
                ${className}
              `}
            >
              <div className="w-full">
                <CardHeader blinkoraItem={blinkoraItem} blinkora={blinkora} isExpanded={defaultExpanded} />

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
