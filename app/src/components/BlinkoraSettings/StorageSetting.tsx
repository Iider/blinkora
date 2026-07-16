import { observer } from "mobx-react-lite";
import { Button, DropdownItem, DropdownMenu, DropdownTrigger, Dropdown, Input } from "@heroui/react";
import { RootStore } from "@/store";
import { BlinkoraStore } from "@/store/blinkoraStore";
import { PromiseCall } from "@/store/standard/PromiseState";
import { Icon } from '@/components/Common/Iconify/icons';
import { api } from "@/lib/trpc";
import { Item } from "./Item";
import { useTranslation } from "react-i18next";
import { useMediaQuery } from "usehooks-ts";
import { useEffect, useState } from "react";
import { PasswordInput } from "@/components/Common/PasswordInput";
import { CollapsibleCard } from "@/components/Common/CollapsibleCard";
import { ToastPlugin } from "@/store/module/Toast/Toast";
import { localizeErrorMessage } from "@/lib/errorMessage";


export const StorageSetting = observer(() => {
  const isPc = useMediaQuery('(min-width: 768px)')
  const { t } = useTranslation()
  const blinkora = RootStore.Get(BlinkoraStore)
  const toast = RootStore.Get(ToastPlugin)
  const [isValidatingS3, setIsValidatingS3] = useState(false)
  const [selectedObjectStorage, setSelectedObjectStorage] = useState<'local' | 's3' | null>(null)
  const store = RootStore.Local(() => ({
    s3AccessKeyId: "",
    s3AccessKeySecret: "",
    s3Endpoint: "",
    s3Region: "",
    s3Bucket: "",
    s3CustomPath: "",
    localCustomPath: "",
  }))
  const activeObjectStorage = blinkora.config.value?.objectStorage === 's3' ? 's3' : 'local'
  const visibleObjectStorage = selectedObjectStorage ?? activeObjectStorage

  useEffect(() => {
    store.s3AccessKeyId = blinkora.config.value?.s3AccessKeyId ?? ''
    store.s3AccessKeySecret = blinkora.config.value?.s3AccessKeySecret ?? ''
    store.s3Endpoint = blinkora.config.value?.s3Endpoint ?? ''
    store.s3Region = blinkora.config.value?.s3Region ?? ''
    store.s3Bucket = blinkora.config.value?.s3Bucket ?? ''
    store.s3CustomPath = blinkora.config.value?.s3CustomPath ?? ''
    store.localCustomPath = blinkora.config.value?.localCustomPath ?? ''
  }, [blinkora.config.value])

  const s3RequiredFieldsFilled = [
    store.s3Endpoint,
    store.s3AccessKeyId,
    store.s3AccessKeySecret,
    store.s3Bucket,
    store.s3Region,
  ].every((value) => String(value ?? '').trim().length > 0)

  const saveAndValidateS3 = async () => {
    if (isValidatingS3) return
    if (!s3RequiredFieldsFilled) {
      toast.error(t('s3-required-fields-missing'))
      return
    }
    setIsValidatingS3(true)

    try {
      const result = await PromiseCall(api.config.saveAndValidateS3.mutate({
        s3Endpoint: store.s3Endpoint ?? '',
        s3AccessKeyId: store.s3AccessKeyId ?? '',
        s3AccessKeySecret: store.s3AccessKeySecret ?? '',
        s3Bucket: store.s3Bucket ?? '',
        s3Region: store.s3Region ?? '',
        s3CustomPath: store.s3CustomPath ?? '',
      }), { autoAlert: false })

      await blinkora.config.call()

      if (result.ok) {
        setSelectedObjectStorage(null)
        toast.success(t('s3-validation-success'))
      } else {
        setSelectedObjectStorage('s3')
        toast.error(`${t('s3-validation-failed-switch-local')}${result.message ? `: ${localizeErrorMessage(result.message)}` : ''}`)
      }
    } catch (error) {
      await blinkora.config.call()
      setSelectedObjectStorage('s3')
      toast.error(localizeErrorMessage(error))
    } finally {
      setIsValidatingS3(false)
    }
  }


  return <CollapsibleCard
    icon="tabler:brush"
    title={t('storage')}
  >
    <Item
      leftContent={<div className="flex flex-col gap-2">
        <div>{t('object-storage')}</div>
      </div>}
      rightContent={<div>
        <Dropdown>
          <DropdownTrigger>
            <Button startContent={<Icon icon="mdi:storage" width="20" height="20" />} color='primary' >
              {visibleObjectStorage === 's3' ? 'S3' : t('local-file-system')}
            </Button>
          </DropdownTrigger>
          <DropdownMenu onAction={async (key) => {
            const nextStorage = key.toString() === 's3' ? 's3' : 'local'
            setSelectedObjectStorage(nextStorage)
            if (nextStorage === 's3') {
              return
            }
            await PromiseCall(api.config.update.mutate({
              key: 'objectStorage',
              value: nextStorage
            }), { autoAlert: false })
            await blinkora.config.call()
            setSelectedObjectStorage(null)
          }}>
            <DropdownItem key="local">  {t('local-file-system')}</DropdownItem>
            <DropdownItem key="s3">S3</DropdownItem>
          </DropdownMenu>


        </Dropdown>
      </div>} />

    {visibleObjectStorage !== 's3' &&
      <Item
        leftContent={<>
          <div>{t('custom-path')}</div>
        </>}
        rightContent={<Input
          value={store.localCustomPath}
          onChange={e => store.localCustomPath = e.target.value}
          placeholder="/custom/path/"
          onBlur={async (e) => {
            await PromiseCall(api.config.update.mutate({
              key: 'localCustomPath',
              value: e.target.value
            }), { autoAlert: false })
          }} />}
      />
    }

    {
      visibleObjectStorage === 's3' && <>
        {activeObjectStorage !== 's3' && <Item
          type="col"
          leftContent={<>{t('s3-pending-validation')}</>}
          rightContent={<div className="text-xs text-warning leading-5">
            {t('s3-pending-validation-desc')}
          </div>}
        />}
        <Item
          leftContent={<>{t('s3-endpoint')}</>}
          rightContent={<Input name="s3Endpoint" value={store.s3Endpoint} onChange={e => store.s3Endpoint = e.target.value} placeholder={t('s3-endpoint')} />} />
        <Item
          leftContent={<>{t('s3-access-key')}</>}
          rightContent={<PasswordInput
            name="s3AccessKeyId"
            autoComplete="off"
            value={store.s3AccessKeyId}
            onChange={e => store.s3AccessKeyId = e.target.value}
            placeholder={t('s3-access-key')}
          />} />
        <Item
          leftContent={<>{t('s3-secret-key')}</>}
          rightContent={<PasswordInput
            name="s3AccessKeySecret"
            autoComplete="off"
            value={store.s3AccessKeySecret}
            onChange={e => store.s3AccessKeySecret = e.target.value}
            placeholder={t('s3-secret-key')}
          />} />
        <Item
          leftContent={<>{t('s3-bucket')}</>}
          rightContent={<Input name="s3Bucket" value={store.s3Bucket} onChange={e => store.s3Bucket = e.target.value} placeholder={t('s3-bucket')} />} />
        <Item
          leftContent={<>{t('s3-region-id')}</>}
          rightContent={<Input name="s3Region" value={store.s3Region} onChange={e => store.s3Region = e.target.value} placeholder={t('s3-region-id')} />} />
        <Item
          leftContent={<>
            <div>{t('s3-custom-path')}</div>
          </>}
          rightContent={<Input
            name="s3CustomPath"
            value={store.s3CustomPath}
            onChange={e => store.s3CustomPath = e.target.value}
            placeholder={t('s3-custom-path')}
          />} />
        <Item
          type="col"
          leftContent={<>{t('s3-configuration-note')}</>}
          rightContent={<div className="text-xs text-default-500 leading-5">
            <div>{t('s3-empty-path-hint')}</div>
            <div>{t('s3-compatible-provider-hint')}</div>
          </div>}
        />
        <Item
          leftContent={<div className="flex flex-col gap-1">
            <div>{t('s3-connection-check')}</div>
            <div className="text-xs text-default-500 font-normal">{t('s3-connection-check-desc')}</div>
          </div>}
          rightContent={<Button
            color="primary"
            isLoading={isValidatingS3}
            isDisabled={!s3RequiredFieldsFilled}
            onPress={saveAndValidateS3}
            startContent={!isValidatingS3 && <Icon icon="mdi:cloud-check-outline" width="20" height="20" />}
          >
            {isValidatingS3 ? t('s3-validating') : t('s3-save-and-validate')}
          </Button>}
        />
      </>
    }


  </CollapsibleCard>
})
