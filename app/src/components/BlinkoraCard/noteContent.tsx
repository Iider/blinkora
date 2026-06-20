import { MarkdownRender } from '@/components/Common/MarkdownRender';
import { FilesAttachmentRender } from "../Common/AttachmentRender";
import { Note } from '@shared/lib/types';
import { BlinkoraStore } from '@/store/blinkoraStore';
import { observer } from 'mobx-react-lite';

interface NoteContentProps {
  blinkoraItem: Note;
  blinkora: BlinkoraStore;
  isExpanded?: boolean;
}

export const NoteContent = observer(({ blinkoraItem, blinkora, isExpanded }: NoteContentProps) => {
  return (
    <>
      <MarkdownRender
        content={blinkoraItem.content}
        onChange={(newContent) => {
          blinkoraItem.content = newContent
          blinkora.upsertNote.call({ id: blinkoraItem.id, content: newContent, refresh: false })
        }}
        largeSpacing={isExpanded}
      />
      <div className={blinkoraItem.attachments?.length != 0 ? 'my-2' : ''}>
        <FilesAttachmentRender files={blinkoraItem.attachments ?? []} preview />
      </div>
    </>
  );
});
