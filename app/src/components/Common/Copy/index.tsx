import { Icon } from '@/components/Common/Iconify/icons';
import { RootStore } from '@/store';
import { ToastPlugin } from '@/store/module/Toast/Toast';
import { Button, Tooltip } from '@heroui/react';
import { useEffect, useRef, useState } from "react";
import { useTranslation } from 'react-i18next';
import { writeTextToClipboard } from '@/lib/clipboard';

type IProps = { content: string, size: number, className?: string };

export const Copy = ({ content, size = 20, className }: IProps) => {
  const { t } = useTranslation();
  const [isCopied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => {
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
    }
  }, []);

  const handleCopy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();

    try {
      await writeTextToClipboard(content);
      setCopied(true);
      RootStore.Get(ToastPlugin).success(t('copied'));

      if (resetTimer.current) {
        clearTimeout(resetTimer.current);
      }
      resetTimer.current = setTimeout(() => setCopied(false), 1000);
    } catch {
      RootStore.Get(ToastPlugin).error(t('operation-failed'));
    }
  };

  return (
    <div className={`flex items-center ${className ?? ''}`}>
      <Tooltip content={t(isCopied ? 'copied' : 'copy')} delay={300}>
        <Button
          aria-label={t(isCopied ? 'copied' : 'copy')}
          data-drag-ignore="true"
          isIconOnly
          size="sm"
          variant="light"
          className="h-auto! w-auto! min-w-0! p-0! bg-transparent! data-[hover=true]:bg-transparent!"
          onClick={handleCopy}
        >
          <Icon
            className={isCopied ? 'text-green-500' : 'text-desc'}
            icon={isCopied ? 'line-md:check-all' : 'si:copy-duotone'}
            width={size}
            height={size}
          />
        </Button>
      </Tooltip>
    </div>
  );
};
