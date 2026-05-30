import { BlinkoraStore } from "@/store/blinkoraStore"
import { RootStore } from "@/store/root"

export const Extend: IHintExtend[] = [{
  key: '#',
  hint(value: string) {
    const blinkora = RootStore.Get(BlinkoraStore)
    return blinkora.tagList?.value?.pathTags.filter(i =>
      i.toLowerCase().includes(value.toLowerCase().replace("#", ''))
    ).map(i => {
      return {
        html: `<span class="blinkora-tag-hint">#${i}</span>`,
        value:`#${i}&nbsp;`
      }
    }) ?? []
  }
}]
