import { Icon } from '@/components/Common/Iconify/icons';
import { SendIcon } from '../../../Icons';
import { EditorStore } from '../../editorStore';
import { observer } from 'mobx-react-lite';
import { useTranslation } from 'react-i18next';

interface Props {
  store: EditorStore;
  isSendLoading?: boolean;
}

export const SendButton = observer(({ store, isSendLoading }: Props) => {
  const { t } = useTranslation();

  return (
    <div
      role="button"
      aria-label={t('submit')}
      aria-disabled={isSendLoading || undefined}
      tabIndex={isSendLoading ? -1 : 0}
      onClick={
        (e) => {
          if(isSendLoading) return
          store.handleSend()
        }
      }
      onTouchEnd={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if(isSendLoading) return
        store.handleSend()
      }}
      onKeyDown={(e) => {
        if (isSendLoading || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        store.handleSend();
      }}
    >
      <div
        className='w-[60px] group ml-2 bg-primary text-foreground flex items-center justify-center rounded-[11px] cursor-pointer h-[32px]' 
      >
        {(store.files?.some(i => i.uploadPromise?.loading?.value) || isSendLoading) ? (
          <Icon icon="eos-icons:three-dots-loading" width="24" height="24" className='text-[#F5A524]'/>
        ) : (
          <SendIcon className='primary-foreground !text-primary-foreground group-hover:rotate-[-35deg] !transition-all' />
        )}
      </div>
    </div>
  );
})
