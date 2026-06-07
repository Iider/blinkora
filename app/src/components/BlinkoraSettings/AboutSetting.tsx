import { observer } from "mobx-react-lite";
import { Image, Chip, Button } from "@heroui/react";
import { RootStore } from "@/store";
import { PromiseState } from "@/store/standard/PromiseState";
import { Icon } from '@/components/Common/Iconify/icons';
import { api } from "@/lib/trpc";
import { useTranslation } from "react-i18next";
import { Item } from "./Item";
import { useEffect } from "react";
import { CollapsibleCard } from "@/components/Common/CollapsibleCard";
import { ToastPlugin } from "@/store/module/Toast/Toast";


export const AboutSetting = observer(() => {
  const { t } = useTranslation();
  const store = RootStore.Local(() => ({
    serverVersion: new PromiseState({
      function: async () => {
        return await api.system.serverVersion.query()
      }
    })
  }))

  useEffect(() => {
    store.serverVersion.call()
  }, [])

  const clearBrowserCache = async () => {
    try {
      // Clear browser Cache Storage used by older builds or third-party assets.
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(
          cacheNames.map(cacheName => caches.delete(cacheName))
        );
      }
      
      RootStore.Get(ToastPlugin).success(t('cache-cleared-successfully'));
      
      // Force hard reload (bypass cache) similar to Ctrl+Shift+R
      setTimeout(() => {
        // Method 1: Use location.reload with force flag (deprecated but still works in some browsers)
        try {
          // @ts-ignore - force parameter is deprecated but still functional
          window.location.reload(true);
        } catch {
          // Method 2: Fallback - reload with cache busting timestamp
          const url = new URL(window.location.href);
          url.searchParams.set('_cache_bust', Date.now().toString());
          window.location.href = url.toString();
        }
      }, 1000);
      
    } catch (error) {
      console.error('Failed to clear cache:', error);
      RootStore.Get(ToastPlugin).error(t('failed-to-clear-cache'));
    }
  };

  return (
    <CollapsibleCard
      icon="tabler:info-circle"
      title={t('about')}
    >
      <div className="flex items-start space-x-4 mb-6">
        <Image src="/logo.png" alt="Blinkora" className="w-16 h-16 rounded-xl" />
        <div>
          <h2 className="text-xl font-semibold">Blinkora</h2>
          <div className="flex flex-col gap-2 mt-1">
            <div className="flex items-center gap-2">
              <Chip
                color="warning"
                variant="flat"
                size="sm"
                className="text-xs"
                startContent={<Icon icon="mingcute:version-fill" width="16" height="16" />}
              >
                {t('server')}: v{store.serverVersion.value}
              </Chip>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="font-medium text-gray-500 mb-2">{t('maintenance')}</h3>
        <Item
          leftContent={<>{t('clear-browser-cache')}</>}
          rightContent={
            <Button
              size="sm"
              color="warning"
              variant="flat"
              startContent={<Icon icon="mdi:cached" width="16" />}
              onPress={clearBrowserCache}
            >
              {t('clear-cache')}
            </Button>
          }
        />
      </div>

    </CollapsibleCard>
  );
});
