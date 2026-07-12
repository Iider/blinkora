import { Button } from "@heroui/react";
import { Icon } from '@/components/Common/Iconify/icons';

interface Action {
  icon: string;
  text: string;
  isDeleteButton?: boolean;
  onClick: () => void;
}

interface MultiSelectToolbarProps {
  show: boolean;
  actions: Action[];
  closeLabel: string;
  onClose: () => void;
}

export const MultiSelectToolbar = ({ show, actions, closeLabel, onClose }: MultiSelectToolbarProps) => {
  if (!show) return null;

  return (
    <div className="fixed bottom-[calc(68px+env(safe-area-inset-bottom))] left-1/2 z-[60] w-[calc(100vw-1rem)] -translate-x-1/2 md:bottom-4 md:w-auto">
      <div className="grid grid-cols-3 gap-1 rounded-xl border-2 border-primary bg-content1 p-2 shadow-lg md:flex md:items-center md:gap-2 md:px-4">
        {actions.map((action, index) => (
          <Button
            key={index}
            className="w-full! min-w-0! px-2! md:w-auto! md:px-3!"
            size="md"
            color={action.isDeleteButton ? "danger" : "default"}
            variant="light"
            startContent={<Icon icon={action.icon} />}
            onPress={action.onClick}
          >
            {action.text}
          </Button>
        ))}
        <Button
          aria-label={closeLabel}
          className="h-10! w-full! min-w-0! md:h-[32px]! md:w-[32px]!"
          size="md"
          variant="light"
          isIconOnly
          startContent={<Icon icon="material-symbols:close" />}
          onPress={onClose}
        />
      </div>
    </div>
  );
};
