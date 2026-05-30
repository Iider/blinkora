import { observer } from 'mobx-react-lite';
import { BasicSetting } from '@/components/BlinkoraSettings/BasicSetting';
import { PerferSetting } from '@/components/BlinkoraSettings/PerferSetting';
import { ScrollArea } from '@/components/Common/ScrollArea';
import { UserStore } from '@/store/user';
import { RootStore } from '@/store';
import { AboutSetting } from '@/components/BlinkoraSettings/AboutSetting';
import { StorageSetting } from '@/components/BlinkoraSettings/StorageSetting';
import { ExportSetting } from '@/components/BlinkoraSettings/ExportSetting';
import { useTranslation } from 'react-i18next';
import { JSX } from 'react';
import { ScrollableTabs, TabItem } from '@/components/Common/ScrollableTabs';
import { useState } from 'react';
import { BlinkoraStore } from '@/store/blinkoraStore';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { Icon } from '@/components/Common/Iconify/icons';
import { allSettingMetas, SettingMeta } from './settingsMeta';

type SettingItem = SettingMeta & {
  component: JSX.Element;
};

const settingComponents: Record<string, JSX.Element> = {
  basic: <BasicSetting />,
  prefer: <PerferSetting />,
  storage: <StorageSetting />,
  export: <ExportSetting />,
  about: <AboutSetting />,
};

const allSettings: SettingItem[] = allSettingMetas.map((setting) => ({
  ...setting,
  component: settingComponents[setting.key],
}));

const Page = observer(() => {
  const user = RootStore.Get(UserStore);
  const blinkoraStore = RootStore.Get(BlinkoraStore);
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string>('basic');
  const isMobile = useMediaQuery('(max-width: 768px)');

  const getVisibleSettings = () => {
    const settings = allSettings.filter((setting) => !setting.requireAdmin || user.isSuperAdmin);

    if (blinkoraStore.searchText) {
      const lowerSearchText = blinkoraStore.searchText.toLowerCase();
      const filteredSettings = settings.filter((setting) =>
        setting.title.toLowerCase().includes(lowerSearchText) ||
        setting.keywords?.some((keyword) => keyword.toLowerCase().includes(lowerSearchText))
      );

      // If no settings match the search criteria, return all settings instead of an empty list
      if (filteredSettings.length === 0) {
        return settings;
      }

      return filteredSettings;
    }

    return settings;
  };

  const getCurrentComponent = () => {
    const setting = allSettings.find((s) => s.key === selected);
    return setting ? <div key={setting.key}>{setting.component}</div> : null;
  };

  const tabItems: TabItem[] = getVisibleSettings().map((setting) => ({
    key: setting.key,
    title: setting.title,
    icon: setting.icon,
  }));

  return (
    <div className="h-full flex flex-col">
      {isMobile ? (
        <div className="w-full">
          <div className="sticky top-0 z-10 w-full">
            <div className="mx-1 backdrop-blur-md bg-background rounded-2xl">
              {isMobile && <div className='h-16'></div>}
              <ScrollableTabs
                items={tabItems}
                selectedKey={selected}
                onSelectionChange={setSelected}
                color="primary"
              />
            </div>
          </div>
          <ScrollArea onBottom={() => { }} className="flex-1">
            <div className="max-w-[1024px] mx-auto flex flex-col gap-6 px-2 py-4">
              {getCurrentComponent()}
            </div>
          </ScrollArea>
        </div>
      ) : (
        <div className="w-full max-w-[1200px] mx-auto px-4 py-4 flex flex-row h-full">
          <div className="w-56 mr-6">
            <div className="rounded-xl bg-background p-1 mb-4">
              <ScrollArea onBottom={() => { }} className="h-auto max-h-[calc(100vh-140px)]">
                <div className="p-1 flex flex-col flex-nowrap gap-1">
                  {tabItems.map((item) => (
                    <button
                      key={item.key}
                      onClick={() => setSelected(item.key)}
                      className={`cursor-pointer flex items-center px-3 py-2 rounded-lg text-sm transition-colors ${selected === item.key
                        ? 'bg-primary text-primary-foreground font-medium'
                        : 'hover:bg-muted/50 text-foreground/80 hover:text-foreground'
                        }`}
                    >
                      {item.icon && (
                        <span className="flex-shrink-0 mr-2">
                          <Icon icon={item.icon} width="18" />
                        </span>
                      )}
                      <span className="font-bold">{typeof item.title === 'string' ? t(item.title) : item.title}</span>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            <ScrollArea onBottom={() => { }} className="h-full">
              <div className="max-w-[900px] mx-auto flex flex-col gap-6">
                {getCurrentComponent()}
              </div>
            </ScrollArea>
          </div>
        </div>
      )}
    </div>
  );
});

export default Page;
