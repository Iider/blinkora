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
import { helper } from "@/lib/helper";
import { CardHeader } from "./cardHeader";
import { CardFooter } from "./cardFooter";
import { FocusEditorFixMobile } from "../Common/Editor/editorUtils";
import { SwipeableCard } from "./SwipeableCard";
import { api } from "@/lib/trpc";
import { FullscreenEditor } from "./FullscreenEditor";
import { SimpleCommentList } from "./annotationButton";
import { confirmDeleteNotes } from "@/lib/noteDeletion";


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
  withoutHoverAnimation?: boolean;
  withoutBoxShadow?: boolean;
}

export const BlinkoraCard = observer(({ blinkoraItem, glassEffect = false, forceBlog = false, withoutBoxShadow = false, withoutHoverAnimation = false, className, defaultExpanded = false }: BlinkoraCardProps) => {
  const isPc = useMediaQuery('(min-width: 768px)');
  const blinkora = RootStore.Get(BlinkoraStore);
  const [isFullscreenEditorOpen, setIsFullscreenEditorOpen] = useState(false);
  const isSelected = blinkora.curMultiSelectIdSet.has(blinkoraItem.id!);

  // DraggableBlinkoraCard reads this flag to disable sorting while fullscreen editing owns the note.
  blinkoraItem.isExpand = blinkora.fullscreenEditorNoteId === blinkoraItem.id;

  if (forceBlog) {
    blinkoraItem.isBlog = true
  } else {
    blinkoraItem.isBlog = (blinkoraItem.content?.length ?? 0) > (blinkora.config.value?.textFoldLength ?? 1000)
  }
  blinkoraItem.title = blinkoraItem.content?.split('\n').find(line => {
    if (!line.trim()) return false;
    if (helper.regex.isContainHashTag.test(line)) return false;
    return true;
  }) || '';


  const handleClick = () => {
    if (blinkora.isMultiSelectMode) {
      blinkora.onMultiSelectNote(blinkoraItem.id!);
    } else if (blinkoraItem.isBlog) {
      setIsFullscreenEditorOpen(true);
      blinkora.fullscreenEditorNoteId = blinkoraItem.id!;
    }
  };

  const handleContextMenu = () => {
    blinkora.curSelectedNote = _.cloneDeep(blinkoraItem);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
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
              onContextMenu={e => !isPc && e.stopPropagation()}
              shadow='none'
              className={`
                flex flex-col p-4 ${glassEffect ? 'bg-transparent' : 'bg-background'} transition-[transform,background-color,box-shadow] duration-150 ease-out group/card
                ${isPc && !withoutHoverAnimation ? 'hover:translate-y-1' : ''}
                ${blinkoraItem.isBlog ? 'cursor-pointer' : ''}
                ${isSelected ? 'ring-2 ring-inset ring-primary/70 bg-primary/5 shadow-sm' : ''}
                ${className}
              `}
            >
              <div className="w-full">
                <CardHeader blinkoraItem={blinkoraItem} blinkora={blinkora} isExpanded={defaultExpanded} />

                {blinkoraItem.isBlog && (
                  <div data-drag-ignore="true">
                    <CardBlogBox blinkoraItem={blinkoraItem} isExpanded={defaultExpanded} />
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
