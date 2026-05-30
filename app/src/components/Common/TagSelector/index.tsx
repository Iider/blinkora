import { Icon } from '@/components/Common/Iconify/icons';
import { Autocomplete, AutocompleteItem } from "@heroui/react";
import { useTranslation } from "react-i18next";
import { RootStore } from "@/store";
import { BlinkoraStore } from "@/store/blinkoraStore";

interface TagSelectorProps {
  selectedTag: string | null;
  onSelectionChange: (key: string) => void;
  variant?: "bordered" | "flat" | "faded" | "underlined";
  className?: string;
}

export default function TagSelector({
  selectedTag,
  onSelectionChange,
  variant = "bordered",
  className = "max-w-full"
}: TagSelectorProps) {
  const { t } = useTranslation();
  const blinkoraStore = RootStore.Get(BlinkoraStore);

  return (
    <Autocomplete
      variant={variant}
      placeholder={t('select-tags')}
      defaultItems={blinkoraStore.tagList.value?.falttenTags || []}
      labelPlacement="outside"
      className={className}
      selectedKey={selectedTag}
      startContent={
        selectedTag ? (
          (() => {
            const tag = blinkoraStore.tagList.value?.falttenTags.find(t => t.id === Number(selectedTag));
            return tag?.icon ? (
              <div>{tag.icon}</div>
            ) : (
              <Icon icon="mingcute:hashtag-line" width="20" height="20" />
            );
          })()
        ) : (
          <Icon icon="mingcute:hashtag-line" width="20" height="20" />
        )
      }
      onSelectionChange={(key) => onSelectionChange(key as string)}
    >
      {(tag: any) => (
        <AutocompleteItem key={tag.id} textValue={tag.name}>
          <div className="flex gap-2 items-center">
            {tag.icon ? (
              <div>{tag.icon}</div>
            ) : (
              <Icon icon="mingcute:hashtag-line" width="20" height="20" />
            )}
            <span className="text-small">{tag.name}</span>
          </div>
        </AutocompleteItem>
      )}
    </Autocomplete>
  );
} 