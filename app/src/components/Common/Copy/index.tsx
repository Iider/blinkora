import { Icon } from '@/components/Common/Iconify/icons';
import { RootStore } from '@/store';
import { ToastPlugin } from '@/store/module/Toast/Toast';
import { Button, Tooltip } from '@heroui/react';
import { useEffect, useRef, useState } from "react";
import { useTranslation } from 'react-i18next';

type IProps = { content: string, size: number, className?: string };

const copyWithCommand = (content: string) => {
  const textarea = document.createElement('textarea');
  textarea.value = content;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);

  try {
    textarea.focus();
    textarea.select();
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
};

const writeTextToClipboard = async (content: string) => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(content);
      return;
    } catch {
      // Some browser contexts expose Clipboard API but deny writes.
    }
  }

  if (!copyWithCommand(content)) {
    throw new Error('Failed to copy text to clipboard');
  }
};

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
