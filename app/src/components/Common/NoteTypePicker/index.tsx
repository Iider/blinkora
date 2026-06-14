import { Icon } from '@/components/Common/Iconify/icons';
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from '@heroui/react';
import { NoteType, toNoteTypeEnum } from '@shared/lib/types';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export type NoteTypeOption = {
  type: NoteType;
  labelKey: string;
  icon: string;
  iconClassName: string;
};

export const NOTE_TYPE_OPTIONS: NoteTypeOption[] = [
  {
    type: NoteType.BLINKORA,
    labelKey: 'blinkora',
    icon: 'basil:lightning-solid',
    iconClassName: 'text-yellow-500',
  },
  {
    type: NoteType.NOTE,
    labelKey: 'note',
    icon: 'solar:notes-minimalistic-bold-duotone',
    iconClassName: 'text-blue-500',
  },
  {
    type: NoteType.TODO,
    labelKey: 'todo',
    icon: 'solar:folder-check-bold',
    iconClassName: 'text-green-500',
  },
];

export const getNoteTypeOption = (noteType?: number | NoteType) => {
  const safeType = toNoteTypeEnum(noteType);
  return NOTE_TYPE_OPTIONS.find(item => item.type === safeType) ?? NOTE_TYPE_OPTIONS[0];
};

type NoteTypePickerProps = {
  value?: number | NoteType;
  onChange: (noteType: NoteType) => void | Promise<void>;
  trigger: (option: NoteTypeOption, label: string) => ReactNode;
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end' | 'left-start' | 'left-end' | 'right-start' | 'right-end';
  tooltip?: ReactNode;
  tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right';
  toolTipClassNames?: any;
};

export const NoteTypePicker = ({
  value,
  onChange,
  trigger,
  placement = 'right-start',
  tooltip,
  tooltipPlacement,
  toolTipClassNames,
}: NoteTypePickerProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const currentOption = getNoteTypeOption(value);
  const currentLabel = t(currentOption.labelKey);

  const picker = (
    <Popover
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      placement={placement}
      offset={4}
      showArrow={false}
    >
      <PopoverTrigger>
        <span
          className="inline-flex"
          data-drag-ignore="true"
          onClick={event => event.stopPropagation()}
          onPointerDown={event => event.stopPropagation()}
        >
          {trigger(currentOption, currentLabel)}
        </span>
      </PopoverTrigger>
      <PopoverContent
        className="min-w-0 rounded-lg border border-border bg-background p-1 shadow-lg"
        data-drag-ignore="true"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center gap-1">
          {NOTE_TYPE_OPTIONS.map(option => {
            const isSelected = option.type === currentOption.type;
            const label = t(option.labelKey);
            return (
              <button
                key={option.type}
                type="button"
                aria-label={`${t('convert-to')} ${label}`}
                className={`h-7 rounded-md px-2 text-xs font-bold flex items-center gap-1 transition-colors select-none whitespace-nowrap ${
                  isSelected
                    ? 'bg-primary/10 text-foreground ring-1 ring-primary/40'
                    : 'text-desc hover:bg-hover'
                }`}
                onClick={async event => {
                  event.stopPropagation();
                  setIsOpen(false);
                  if (option.type !== currentOption.type) {
                    await onChange(option.type);
                  }
                }}
              >
                <Icon className={option.iconClassName} icon={option.icon} width="13" height="13" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );

  if (!tooltip) {
    return picker;
  }

  return (
    <Tooltip
      placement={tooltipPlacement}
      classNames={toolTipClassNames}
      content={tooltip}
      delay={1000}
    >
      <span className="inline-flex">
        {picker}
      </span>
    </Tooltip>
  );
};
