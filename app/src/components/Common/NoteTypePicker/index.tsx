import { Icon } from '@/components/Common/Iconify/icons';
import { Tooltip } from '@heroui/react';
import { NoteType, toNoteTypeEnum } from '@shared/lib/types';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
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
  tooltip?: ReactNode;
  tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right';
  toolTipClassNames?: any;
};

export const NoteTypePicker = ({
  value,
  onChange,
  trigger,
  tooltip,
  tooltipPlacement,
  toolTipClassNames,
}: NoteTypePickerProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [floatingPosition, setFloatingPosition] = useState({ left: 0, bottom: 0 });
  const triggerRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const currentOption = getNoteTypeOption(value);
  const currentLabel = t(currentOption.labelKey);

  const updateFloatingPosition = () => {
    const triggerElement = triggerRef.current;
    if (!triggerElement) return;

    const boundaryElement = triggerElement.closest('[data-note-type-picker-boundary="true"]') ?? triggerElement;
    const rect = boundaryElement.getBoundingClientRect();

    setFloatingPosition({
      left: Math.max(8, rect.left),
      bottom: Math.max(8, window.innerHeight - rect.bottom),
    });
  };

  useEffect(() => {
    if (!isOpen) return;

    updateFloatingPosition();

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || contentRef.current?.contains(target)) return;
      setIsOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('resize', updateFloatingPosition);
    window.addEventListener('scroll', updateFloatingPosition, true);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('resize', updateFloatingPosition);
      window.removeEventListener('scroll', updateFloatingPosition, true);
    };
  }, [isOpen]);

  const pickerContent = isOpen && typeof document !== 'undefined'
    ? createPortal(
      <div
        ref={contentRef}
        className="fixed z-[10000] min-w-0 rounded-lg border border-border bg-background p-1 shadow-lg"
        data-drag-ignore="true"
        data-note-type-picker-content="true"
        style={{
          left: floatingPosition.left,
          bottom: floatingPosition.bottom,
        }}
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
      </div>,
      document.body
    )
    : null;

  const picker = (
    <>
      <span
        ref={triggerRef}
        className="inline-flex"
        data-drag-ignore="true"
        onClick={event => {
          event.stopPropagation();
          updateFloatingPosition();
          setIsOpen(value => !value);
        }}
        onPointerDown={event => event.stopPropagation()}
      >
        {trigger(currentOption, currentLabel)}
      </span>
      {pickerContent}
    </>
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
