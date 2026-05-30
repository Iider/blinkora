
import { BlinkoraStore } from '@/store/blinkoraStore';
import { _ } from '@/lib/lodash';
import { observer } from 'mobx-react-lite';
import { RootStore } from '@/store';
import { Button, Input, Select, SelectItem } from '@heroui/react';
import { useEffect } from 'react';
import { DialogStore } from '@/store/module/Dialog';
import { useTranslation } from 'react-i18next';
import i18n from '@/lib/i18n';


type IProps = {
  defaultValue?: string,
  type?: 'input' | 'select',
  onSave?: (tagName: string) => Promise<any>
}

export const UpdateTag = observer(({ onSave, defaultValue = '', type = 'input' }: IProps) => {
  const { t } = useTranslation();
  const blinkora = RootStore.Get(BlinkoraStore)
  const store = RootStore.Local(() => ({
    tagName: ''
  }))
  useEffect(() => {
    store.tagName = defaultValue
  }, [defaultValue])

  return <div className="flex items-center gap-2 pb-4">
    {
      type == 'input' ? <Input value={store.tagName} onChange={e => store.tagName = (e.target.value)} />
        : <Select
          label={t('select-a-tag')}
          className="max-w-xs"
          onChange={e => store.tagName = e.target.value}
        >
          {(blinkora.tagList.value?.pathTags as string[]).map((tag) => (
            <SelectItem key={tag}>
              {tag}
            </SelectItem>
          ))}
        </Select>
    }

    <Button style={{ width: '30px' }} color="primary" onPress={async () => {
      await onSave?.(store.tagName)
      RootStore.Get(DialogStore).close()
    }}>{t('save')}</Button>
  </div>
})

export const ShowUpdateTagDialog = ({ onSave, defaultValue, type }: IProps) => {
  RootStore.Get(DialogStore).setData({
    isOpen: true,
    title: i18n.t('update-tag-name'),
    content: <UpdateTag type={type} defaultValue={defaultValue} onSave={async (e) => { return await onSave?.(e) }} />
  })
}
