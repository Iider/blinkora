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


export const StorageSetting = observer(() => {
  const isPc = useMediaQuery('(min-width: 768px)')
  const { t } = useTranslation()
  const blinkora = RootStore.Get(BlinkoraStore)
  const toast = RootStore.Get(ToastPlugin)
  const [isValidatingS3, setIsValidatingS3] = useState(false)
  const store = RootStore.Local(() => ({
    s3AccessKeyId: "",
    s3AccessKeySecret: "",
    s3Endpoint: "",
    s3Region: "",
    s3Bucket: "",
    s3CustomPath: "",
    localCustomPath: "",
  }))

  useEffect(() => {
    store.s3AccessKeyId = blinkora.config.value?.s3AccessKeyId!
    store.s3AccessKeySecret = blinkora.config.value?.s3AccessKeySecret!
    store.s3Endpoint = blinkora.config.value?.s3Endpoint!
    store.s3Region = blinkora.config.value?.s3Region!
    store.s3Bucket = blinkora.config.value?.s3Bucket!
    store.s3CustomPath = blinkora.config.value?.s3CustomPath!
    store.localCustomPath = blinkora.config.value?.localCustomPath!
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
        toast.success(t('s3-validation-success'))
      } else {
        toast.error(`${t('s3-validation-failed-switch-local')}${result.message ? `: ${result.message}` : ''}`)
      }
    } catch (error) {
      await blinkora.config.call()
      toast.error(error instanceof Error ? error.message : t('operation-failed'))
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
              {blinkora.config.value?.objectStorage ?? t('local-file-system')}
            </Button>
          </DropdownTrigger>
          <DropdownMenu onAction={async (key) => {
            await PromiseCall(api.config.update.mutate({
              key: 'objectStorage',
              value: key.toString()
            }), { autoAlert: false })
            await blinkora.config.call()
          }}>
            <DropdownItem key="local">  {t('local-file-system')}</DropdownItem>
            <DropdownItem key="s3">S3</DropdownItem>
          </DropdownMenu>


        </Dropdown>
      </div>} />

    {blinkora.config.value?.objectStorage != 's3' &&
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
      blinkora.config.value?.objectStorage === 's3' && <>
        <Item
          leftContent={<>{t('s3-endpoint')}</>}
          rightContent={<Input value={store.s3Endpoint} onChange={e => store.s3Endpoint = e.target.value} placeholder={t('s3-endpoint')} onBlur={async (e) => {
            await PromiseCall(api.config.update.mutate({
              key: 's3Endpoint',
              value: e.target.value
            }), { autoAlert: false })
          }} />} />
        <Item
          leftContent={<>{t('s3-access-key')}</>}
          rightContent={<PasswordInput
            name="s3AccessKeyId"
            autoComplete="off"
            value={store.s3AccessKeyId}
            onChange={e => store.s3AccessKeyId = e.target.value}
            placeholder={t('s3-access-key')}
            onBlur={async (e) => {
              await PromiseCall(api.config.update.mutate({
                key: 's3AccessKeyId',
                value: e.target.value
              }), { autoAlert: false })
            }} />} />
        <Item
          leftContent={<>{t('s3-secret-key')}</>}
          rightContent={<PasswordInput
            name="s3AccessKeySecret"
            autoComplete="off"
            value={store.s3AccessKeySecret}
            onChange={e => store.s3AccessKeySecret = e.target.value}
            placeholder={t('s3-secret-key')}
            onBlur={async (e) => {
              await PromiseCall(api.config.update.mutate({
                key: 's3AccessKeySecret',
                value: e.target.value
              }), { autoAlert: false })
            }} />} />
        <Item
          leftContent={<>{t('s3-bucket')}</>}
          rightContent={<Input value={store.s3Bucket} onChange={e => store.s3Bucket = e.target.value} placeholder={t('s3-bucket')} onBlur={async (e) => {
            await PromiseCall(api.config.update.mutate({
              key: 's3Bucket',
              value: e.target.value
            }), { autoAlert: false })
          }} />} />
        <Item
          leftContent={<>{t('s3-region-id')}</>}
          rightContent={<Input value={store.s3Region} onChange={e => store.s3Region = e.target.value} placeholder={t('s3-region-id')} onBlur={async (e) => {
            await PromiseCall(api.config.update.mutate({
              key: 's3Region',
              value: e.target.value
            }), { autoAlert: false })
          }} />} />
        <Item
          leftContent={<>
            <div>{t('s3-custom-path')}</div>
          </>}
          rightContent={<Input
            value={store.s3CustomPath}
            onChange={e => store.s3CustomPath = e.target.value}
            placeholder={t('s3-custom-path')}
            onBlur={async (e) => {
              await PromiseCall(api.config.update.mutate({
                key: 's3CustomPath',
                value: e.target.value
              }), { autoAlert: false })
            }} />} />
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
