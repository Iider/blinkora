import { Input, Popover, PopoverContent, PopoverTrigger } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import { BlinkoraStore } from '@/store/blinkoraStore';
import { RootStore } from '@/store';
import { ScrollArea } from '../ScrollArea';
import { IconButton } from '../Editor/Toolbar/IconButton';
import { useState, useCallback } from 'react';
import { getDisplayTime } from '@/lib/helper';
import { throttle } from 'lodash';
import { useTranslation } from 'react-i18next';

interface Props {
  iconButton?: React.ReactNode;
  onSelect: (item: any) => void;
  blackList?: number[];
  tooltip?: string;
  autoClose?: boolean;
}

export const BlinkoraSelectNote = observer(({ iconButton, onSelect, blackList = [], tooltip = 'reference', autoClose = true }: Props) => {
  const blinkora = RootStore.Get(BlinkoraStore);
  const [isOpen, setIsOpen] = useState(false);
  const { t } = useTranslation();

  const defaultIconButton = <IconButton tooltip={t(tooltip)} icon="ph:link" />;

  const throttleSearch = useCallback(
    throttle(
      (searchText: string) => {
        const blinkora = RootStore.Get(BlinkoraStore);
        blinkora.referenceSearchList.resetAndCall({ searchText });
      },
      500,
      { trailing: true, leading: false },
    ),
    [],
  );

  const handleSearch = useCallback(
    (searchText: string) => {
      throttleSearch(searchText);
    },
    [throttleSearch],
  );

  return (
    <Popover
      placement="bottom"
      isOpen={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (open) {
          blinkora.referenceSearchList.resetAndCall({ searchText: ' ' });
        }
      }}
    >
      <PopoverTrigger>
        <div>{iconButton || defaultIconButton}</div>
      </PopoverTrigger>
      <PopoverContent className="flex flex-col max-w-[300px]">
        <Input onChange={(e) => handleSearch(e.target.value)} type="text" autoFocus className="w-full my-1 focus:outline-none focus:ring-0" placeholder={t('search')} size="sm" />
        <ScrollArea
          className="max-h-[400px] max-w-[290px] flex flex-col gap-1"
          onBottom={() => {
            blinkora.referenceSearchList.callNextPage({});
          }}
        >
          {blinkora.referenceSearchList?.value?.map((item) => {
            if (typeof item.id !== 'number') return null;
            const noteId = item.id;
            return (
            <div
              key={item.id}
              role="button"
              aria-label={item.content}
              aria-disabled={blackList.includes(noteId)}
              data-reference-option="true"
              tabIndex={blackList.includes(noteId) ? -1 : 0}
              className={`flex flex-col w-full bg-background hover:bg-hover rounded-md cursor-pointer p-1
                ${blackList.includes(noteId) ? 'opacity-50 pointer-events-none' : ''}`}
              onClick={() => {
                if (!blackList.includes(noteId)) {
                  if (autoClose) {
                    setIsOpen(false);
                  }
                  onSelect(item);
                }
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.currentTarget.click();
              }}
            >
              <div className="flex flex-col w-full p-1">
                <div className="text-xs text-desc">{getDisplayTime(item.createdAt, item.updatedAt)}</div>
                <div className="text-sm line-clamp-2">{item.content}</div>
              </div>
            </div>
            );
          })}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
});
