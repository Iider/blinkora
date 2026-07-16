import { Icon } from '@/components/Common/Iconify/icons';
import { observer } from 'mobx-react-lite';
import { RootStore } from '@/store';
import { TipsPopover } from '@/components/Common/TipsDialog';
import { ToastPlugin } from '@/store/module/Toast/Toast';
import { useTranslation } from 'react-i18next';
import { BlinkoraStore } from '@/store/blinkoraStore';
import { FileType } from '../Editor/type';
import { Tooltip } from '@heroui/react';
import { eventBus } from '@/lib/event';
import { getBlinkoraEndpoint } from '@/lib/blinkoraEndpoint';
import axiosInstance from '@/lib/axios';
import { downloadFromLink } from '@/lib/browserRuntime';
import { runInAction } from 'mobx';
import { useState } from 'react';
import { localizeErrorMessage } from '@/lib/errorMessage';

const resolveFilePath = (file: FileType) => file.uploadPromise?.value || file.preview;

export const DeleteIcon = observer(({ className, file, files, size = 20, onDeleted }: { className: string, file: FileType, files: FileType[], size?: number, onDeleted?: (file: FileType) => void }) => {
  const { t } = useTranslation()
  const [isDeleting, setIsDeleting] = useState(false)

  const deleteFile = async () => {
    if (isDeleting) return
    setIsDeleting(true)
    try {
      const path = resolveFilePath(file);
      const blinkora = RootStore.Get(BlinkoraStore);
      const attachedToNote = Boolean(
        file.attachedToNote || blinkora.curSelectedNote?.attachments?.some(
          attachment => path && attachment.path === path,
        ),
      );
      const isSameFile = (item: FileType) => {
        const itemPath = resolveFilePath(item);
        if (path && itemPath) return itemPath === path;
        return item.name === file.name;
      }

      if (path && !attachedToNote) {
        try {
          await axiosInstance.post(getBlinkoraEndpoint('/api/file/delete'), {
            attachment_path: path,
          });
        } catch (error: any) {
          if (error?.response?.status !== 404) throw error;
        }
      }
      if (onDeleted) {
        onDeleted({ ...file, attachedToNote })
      } else {
        runInAction(() => {
          files.splice(0, files.length, ...files.filter(i => !isSameFile(i)))
        })
      }
      if (!attachedToNote) {
        blinkora.removeAttachmentFromClient(
          { name: file.name, path },
          blinkora.curSelectedNote?.id,
        )
      }
      RootStore.Get(ToastPlugin).success(t('delete-success'))
    } catch (error) {
      RootStore.Get(ToastPlugin).error(localizeErrorMessage(error))
    } finally {
      setIsDeleting(false)
    }
  }

  return <>
    <TipsPopover isLoading={isDeleting} content={t('this-operation-will-be-delete-resource-are-you-sure')}
      onConfirm={deleteFile}>
      <button
        type="button"
        aria-label={t('delete')}
        className={`opacity-70 hover:opacity-100 bg-black cursor-pointer rounded-sm transition-al ${className}`}
      >
        <Icon className='!text-white' icon="basil:cross-solid" width={size} height={size} />
      </button>
    </TipsPopover >
  </>
})

export const InsertConextButton = observer(({ className, file, files, size = 20 }: { className: string, file: FileType, files: FileType[], size?: number }) => {
  const { t } = useTranslation()
  return <>
    <Tooltip content={t('insert-context')}>
      <div onClick={(e) => {
        e.stopPropagation()
        eventBus.emit('editor:insert', `![${file.name}](${file.preview})`)
      }} className={`opacity-70 hover:opacity-100 bg-black cursor-pointer rounded-sm transition-al ${className}`}>
        <Icon className='!text-white' icon="material-symbols:variable-insert-outline-rounded" width={size} height={size} />
      </div>
    </Tooltip>
  </>
})

export const DownloadIcon = observer(({ className, file, size = 20 }: { className?: string, file: FileType, size?: number }) => {
  return <div className={`hidden p-1 group-hover:block !transition-all absolute z-10 right-[5px] top-[5px] !text-background opacity-70 hover:opacity-100 !bg-foreground cursor-pointer rounded-sm !transition-all ${className}`}>
    <Icon onClick={() => {
      downloadFromLink(getBlinkoraEndpoint(file.uploadPromise.value));
    }} icon="tabler:download" width="15" height="15" />
  </div>
})

export const CopyIcon = observer(({ className, file, size = 20 }: { className?: string, file: FileType, size?: number }) => {
  const { t } = useTranslation()

  const copyImageToClipboard = async () => {
    try {
      const src = file.uploadPromise?.value || file.preview;
      if (!src) return;

      // Get the image as a blob
      const response = await axiosInstance.get(getBlinkoraEndpoint(src), {
        responseType: 'blob'
      });

      // Convert to canvas and then to PNG format for better clipboard support
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const img = new Image();

      return new Promise((resolve, reject) => {
        img.onload = async () => {
          canvas.width = img.width;
          canvas.height = img.height;
          ctx?.drawImage(img, 0, 0);

          canvas.toBlob(async (blob) => {
            if (!blob) {
              reject(new Error('Failed to convert image to blob'));
              return;
            }

            try {
              // Try to write PNG blob to clipboard
              await navigator.clipboard.write([
                new ClipboardItem({
                  'image/png': blob
                })
              ]);

              RootStore.Get(ToastPlugin).success(t('operation-success'));
              resolve(true);
            } catch (clipboardError) {
              console.error('Clipboard write failed, trying fallback:', clipboardError);

              // Fallback: copy image URL as text
              try {
                await navigator.clipboard.writeText(getBlinkoraEndpoint(src));
                RootStore.Get(ToastPlugin).success(t('operation-success'));
                resolve(true);
              } catch (textError) {
                console.error('Text fallback also failed:', textError);
                RootStore.Get(ToastPlugin).error(t('operation-failed'));
                reject(textError);
              }
            }
          }, 'image/png');
        };

        img.onerror = () => {
          reject(new Error('Failed to load image'));
        };

        img.src = URL.createObjectURL(response.data);
      });
    } catch (error) {
      console.error('Failed to copy image to clipboard:', error);
      RootStore.Get(ToastPlugin).error(t('operation-failed'));
    }
  };

  return <div className={`hidden p-1 group-hover:block !transition-all absolute z-10 right-[30px] top-[5px] !text-background opacity-70 hover:opacity-100 !bg-foreground cursor-pointer rounded-sm !transition-all ${className}`}>
    <Icon onClick={copyImageToClipboard} icon="si:copy-duotone" width="15" height="15" />
  </div>
})
