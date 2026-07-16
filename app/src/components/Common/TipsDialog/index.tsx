import { RootStore } from "@/store";
import { Icon } from '@/components/Common/Iconify/icons';
import { observer } from "mobx-react-lite";
import { useTranslation } from "react-i18next";
import { Popover, PopoverTrigger, PopoverContent, Button, Spinner } from "@heroui/react";
import { button as buttonStyles } from "@heroui/theme";
import { DialogStandaloneStore } from "@/store/module/DialogStandalone";
import { useState } from "react";

const TipsDialog = observer(({ content, onConfirm, onCancel, buttonSlot }: any) => {
  const { t } = useTranslation()
  return <div className='flex flex-col'>
    <div className='flex gap-4 items-center '>
      <div className="ml-4">{content}</div>
    </div>
    <div className='flex my-4 gap-4'>
      {
        buttonSlot ? buttonSlot : <>
          <Button className="ml-auto" color='default'
            onPress={() => {
              RootStore.Get(DialogStandaloneStore).close()
              onCancel?.()
            }}>{t('cancel')}</Button>
          <Button color='danger' onPress={() => {
            onConfirm?.()
          }}>{t('confrim')}</Button>
        </>
      }
    </div>
  </div>
})

export const showTipsDialog = async (props: { size?: 'sm' | 'md' | 'lg' | 'xl', title: string, content: React.ReactNode, onConfirm?, onCancel?: any, buttonSlot?: React.ReactNode }) => {
  RootStore.Get(DialogStandaloneStore).setData({
    isOpen: true,
    onlyContent: false,
    size: props.size || 'md',
    title: props.title,
    content: <TipsDialog {...props} />
  })
}

export const TipsPopover = observer((props: { children: React.ReactNode, content, onConfirm, onCancel?, isLoading?: boolean }) => {
  const { t } = useTranslation()
  const { isLoading = false } = props
  const [isOpen, setIsOpen] = useState(false)

  const handleCancel = () => {
    setIsOpen(false)
    props.onCancel?.()
  }

  const handleConfirm = async () => {
    await props.onConfirm?.()
    setIsOpen(false)
  }

  return <Popover placement="bottom" showArrow={true} isOpen={isOpen} onOpenChange={setIsOpen}>
    <PopoverTrigger>
      {props.children}
    </PopoverTrigger>
    <PopoverContent>
      <div className="px-1 py-2 flex flex-col">
        <div className='text-yellow-500 '>
          <div className="font-bold mb-2">{props.content}</div>
        </div>
        <div className='flex my-1 gap-2'>
          <button
            type="button"
            className={`${buttonStyles({ variant: 'flat', size: 'sm', color: 'default' })} ml-auto`}
            onClick={handleCancel}
          >
            <Icon icon="iconoir:cancel" width="20" height="20" />
            {t('cancel')}
          </button>
          <button
            type="button"
            aria-busy={isLoading}
            disabled={isLoading}
            className={buttonStyles({ size: 'sm', color: 'danger', isDisabled: isLoading })}
            onClick={() => void handleConfirm()}
          >
            {isLoading
              ? <Spinner size="sm" color="current" />
              : <Icon icon="cil:check-alt" width="20" height="20" />}
            {t('confirm')}
          </button>
        </div>
      </div>
    </PopoverContent>
  </Popover>
})
