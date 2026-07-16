import { useState } from 'react';
import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { observer } from 'mobx-react-lite';
import { Icon } from '@/components/Common/Iconify/icons';
import { RootStore } from '@/store';
import { UserStore } from '@/store/user';
import { WorkspaceStore } from '@/store/workspace';
import { withBlinkoraFileAccessToken } from '@/lib/blinkoraEndpoint';
import { FileType } from '../Editor/type';
import { DeleteIcon, DownloadIcon } from './icons';

interface Props {
  files: FileType[];
  preview?: boolean;
  onDelete?: (file: FileType) => void;
}

const INITIAL_DISPLAY_COUNT = 3;

const buildAudioUrl = (preview: string) => {
  const token = RootStore.Get(UserStore).tokenData?.value?.token;
  const workspaceId = RootStore.Get(WorkspaceStore).workspaceId;
  return withBlinkoraFileAccessToken(preview, token, workspaceId);
};

export const AudioRender = observer(({ files, preview = false, onDelete }: Props) => {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const audioFiles = files?.filter((item) => item.previewType === 'audio') || [];
  const visibleAudioFiles = showAll ? audioFiles : audioFiles.slice(0, INITIAL_DISPLAY_COUNT);

  return (
    <div className="flex flex-col gap-2">
      {visibleAudioFiles.map((file, index) => (
        <div
          key={`${file.name}-${index}`}
          className="group flex items-center gap-3 rounded-xl border border-default-200 bg-default-50 p-3"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-500 text-white">
            <Icon icon="ph:music-notes-fill" className="h-5 w-5" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="mb-2 truncate text-sm font-medium">{file.name}</div>
            <audio controls preload="metadata" className="h-9 w-full">
              <source src={buildAudioUrl(file.preview)} />
            </audio>
          </div>

          {!file.uploadPromise?.loading?.value && !preview && (
            <DeleteIcon
              files={files}
              className="ml-2 text-gray-400 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-500"
              file={file}
              onDeleted={onDelete}
            />
          )}
          {preview && (
            <DownloadIcon
              className="ml-2 text-gray-400 hover:text-blue-500"
              file={file}
            />
          )}
        </div>
      ))}

      {audioFiles.length > INITIAL_DISPLAY_COUNT && (
        <div className="flex w-full justify-center">
          <Button
            variant="light"
            className="mt-2 w-fit"
            onPress={() => setShowAll(!showAll)}
          >
            <Icon
              icon={showAll ? 'ph:caret-up' : 'ph:caret-down'}
              className="mr-2"
            />
            {showAll ? t('collapse') : `${t('show-all')} (${audioFiles.length})`}
          </Button>
        </div>
      )}
    </div>
  );
});
