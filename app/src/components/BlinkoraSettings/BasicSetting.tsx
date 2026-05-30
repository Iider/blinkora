import { observer } from "mobx-react-lite";
import { Button, Input, Switch, Tooltip, Image } from "@heroui/react";
import { RootStore } from "@/store";
import { Icon } from '@/components/Common/Iconify/icons';
import { UserStore } from "@/store/user";
import { useTranslation } from "react-i18next";
import { DialogStore } from "@/store/module/Dialog";
import { UpdateUserInfo, UpdateUserPassword } from "../Common/UpdateUserInfo";
import { Item } from "./Item";
import { Copy } from "../Common/Copy";
import { MarkdownRender } from "../Common/MarkdownRender";
import { PromiseCall } from "@/store/standard/PromiseState";
import { api } from "@/lib/trpc";
import { BlinkoraStore } from "@/store/blinkoraStore";
import { motion, AnimatePresence } from "motion/react";
import { ShowGen2FATokenModal } from "../Common/TwoFactorModal/gen2FATokenModal";
import { CollapsibleCard } from "../Common/CollapsibleCard";
import { eventBus } from "@/lib/event";
import { UploadFileWrapper } from "../Common/UploadFile";
import { signOut } from "../Auth/auth-client";
import { getBlinkoraEndpoint } from "@/lib/blinkoraEndpoint";

export const BasicSetting = observer(() => {
  const user = RootStore.Get(UserStore)
  const CODE = `curl -X 'POST' '${getBlinkoraEndpoint() ?? window.location.origin}api/v1/note/upsert' \\\n      -H 'Content-Type: application/json' \\\n      -H 'Authorization: Bearer ${user.userInfo.value?.token}' \\\n      -d '{ "content": "🎉Hello,Blinkora! --send from api ", "type":0 }'\n`
  const CODE_SNIPPET = `\`\`\`javascript\n //blinkora api document:${getBlinkoraEndpoint() ?? window.location.origin}/api-doc\n ${CODE} \`\`\``
  const { t } = useTranslation()
  const blinkora = RootStore.Get(BlinkoraStore)

  const store = RootStore.Local(() => ({
    totpToken: '',
    showToken: false,
    showQRCode: false,
    totpSecret: '',
    qrCodeUrl: '',
    setShowToken(value: boolean) {
      this.showToken = value;
    },
    setShowQRCode(value: boolean) {
      this.showQRCode = value;
    },
    setTotpSecret(value: string) {
      this.totpSecret = value;
    },
    setQrCodeUrl(value: string) {
      this.qrCodeUrl = value;
    },
  }))

  return (
    <CollapsibleCard
      icon="tabler:settings"
      title={t('basic-information')}
    >
      <Item
        leftContent={<>{t('name')}</>}
        rightContent={
          <div className="flex gap-2 items-center">
            <div className="text-desc">{user.name}</div>
            <div className="relative group">
              <UploadFileWrapper
                acceptImage
                onUpload={async ({ filePath }) => {
                  if (!user.userInfo.value?.id) return
                  await PromiseCall(api.users.upsertUser.mutate({
                    id: user.userInfo.value?.id,
                    image: filePath
                  }));
                  await user.userInfo.call(Number(user.id))
                  await signOut({ callbackUrl: '/signin' })
                  eventBus.emit('user:signout')
                }}
              >
                {user.userInfo.value?.image ? (
                  <img
                    src={getBlinkoraEndpoint(`${user.userInfo.value.image}?token=${user.tokenData.value?.token}`)}
                    alt="avatar"
                    className="w-10 h-10 rounded-full object-cover cursor-pointer hover:opacity-80 transition-opacity"
                  />
                ) : (
                  <Image src="/logo.png" width={30} />
                )}
              </UploadFileWrapper>
            </div>

            <Button variant="flat" isIconOnly startContent={<Icon icon="tabler:edit" width="20" height="20" />} size='sm'
              onPress={e => {
                RootStore.Get(DialogStore).setData({
                  isOpen: true,
                  title: t('change-user-info'),
                  content: <UpdateUserInfo />
                })
              }} />
            <Button variant="flat" isIconOnly startContent={<Icon icon="material-symbols:password" width="20" height="20" />} size='sm'
              onPress={e => {
                RootStore.Get(DialogStore).setData({
                  title: t('rest-user-password'),
                  isOpen: true,
                  content: <UpdateUserPassword />
                })
              }} />
          </div>
        }
      />

      <Item
        leftContent={
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <div>{t('access-token')}</div>
              <Button
                isIconOnly
                variant="flat"
                size="sm"
                onPress={() => {
                  store.setShowToken(!store.showToken)
                }}
              >
                <Icon
                  icon={store.showToken ? "mdi:eye-off" : "mdi:eye"}
                  width="20"
                  height="20"
                />
              </Button>
            </div>
            <div className="text-xs text-default-500">{t('access-token-desc')}</div>
          </div>
        }
        rightContent={
          <div className="flex gap-2 items-center">
            <Input
              disabled
              className="w-[150px] md:w-[300px]"
              value={store.showToken ? user.userInfo.value?.token : '••••••••••••••••'}
              type={store.showToken ? "text" : "password"}
              endContent={<Copy size={20} content={user.userInfo.value?.token ?? ''} />}
            />

            <Icon
              className="cursor-pointer hover:rotate-180 !transition-all"
              onClick={async () => {
                await PromiseCall(api.users.regenToken.mutate())
                console.log('user.id', user.id);
                user.userInfo.call(Number(user.id))
              }}
              icon="fluent:arrow-sync-12-filled"
              width="20"
              height="20"
            />
          </div>
        }
      />

      {
        <AnimatePresence>
          {store.showToken && (
            <motion.div
              initial={{ height: 0, opacity: 0, scale: 0.95 }}
              animate={{
                height: "auto",
                opacity: 1,
                scale: 1,
              }}
              exit={{
                height: 0,
                opacity: 0,
                scale: 0.95
              }}
              transition={{
                duration: 0.3,
                ease: [0.23, 1, 0.32, 1],
                scale: {
                  type: "spring",
                  damping: 15,
                  stiffness: 300
                }
              }}
            >
              <Item
                leftContent={
                  <div className="w-full flex-1 relative">
                    <Copy size={20} content={CODE} className="absolute top-4 right-2" />
                    <MarkdownRender content={CODE_SNIPPET} />
                  </div>
                }
              />
            </motion.div>
          )}
        </AnimatePresence>
      }

      <Item
        leftContent={<>{t('hide-pc-editor')}</>}
        rightContent={
          <div className="flex gap-2 items-center">
            <Switch
              isSelected={blinkora.config.value?.hidePcEditor ?? false}
              onChange={async (e) => {
                await PromiseCall(api.config.update.mutate({
                  key: 'hidePcEditor',
                  value: e.target.checked
                }));
                blinkora.config.call();
              }}
            />
          </div>
        }
      />

      <Item
        leftContent={<>{t('two-factor-authentication')}</>}
        rightContent={
          <div className="flex gap-2 items-center">
            <Switch
              isSelected={blinkora.config.value?.twoFactorEnabled ?? false}
              onChange={async (e) => {
                if (!e.target.checked) {
                  await PromiseCall(api.config.update.mutate({
                    key: 'twoFactorEnabled',
                    value: false
                  }));
                  blinkora.config.call();
                } else {
                  const response = await PromiseCall(api.users.generate2FASecret.mutate({
                    name: user.name!
                  }), { autoAlert: false });
                  if (response) {
                    ShowGen2FATokenModal({
                      qrCodeUrl: response.qrCode,
                      totpSecret: response.secret
                    })
                  }
                }
              }}
            />
          </div>
        }
      />

      <Item
        leftContent={<></>}
        rightContent={
          <Tooltip placement="bottom" content={t('logout')}>
            <Button isIconOnly startContent={<Icon icon="hugeicons:logout-05" width="20" height="20" />} color='danger' onPress={async () => {
              await signOut({ callbackUrl: '/signin' })
              eventBus.emit('user:signout')
            }}></Button>
          </Tooltip>
        } />
    </CollapsibleCard>
  );
})
