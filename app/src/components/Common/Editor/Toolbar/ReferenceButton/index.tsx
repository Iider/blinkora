import { observer } from 'mobx-react-lite'
import { BlinkoraStore } from '@/store/blinkoraStore'
import { RootStore } from '@/store'
import { EditorStore } from '../../editorStore'
import { useEffect } from 'react'
import { BlinkoraSelectNote } from '@/components/Common/BlinkoraSelectNote'

interface Props {
  store: EditorStore
}

export const ReferenceButton = observer(({ store }: Props) => {
  const blinkora = RootStore.Get(BlinkoraStore)
  useEffect(() => {
    blinkora.referenceSearchList.resetAndCall({ searchText: ' ' })
  }, [])
  return (
    <BlinkoraSelectNote
      onSelect={(item) => {
        if (store.references?.includes(item.id)) return;
        store.addReference(item.id);
      }}
      blackList={store.references}
    />
  )
}) 