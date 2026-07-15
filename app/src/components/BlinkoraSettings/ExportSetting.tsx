import { observer } from "mobx-react-lite";
import { Button, Card, Select, SelectItem, Popover, PopoverTrigger, PopoverContent } from "@heroui/react";
import { RootStore } from "@/store";
import { PromiseCall } from "@/store/standard/PromiseState";
import dayjs from "@/lib/dayjs";
import { api } from "@/lib/trpc";
import { Item } from "./Item";
import { useTranslation } from "react-i18next";
import { useRef, useState } from "react";
import { RangeCalendar } from "@heroui/react";
import { today, getLocalTimeZone } from "@internationalized/date";
import { ToastPlugin } from "@/store/module/Toast/Toast";
import { Icon } from '@/components/Common/Iconify/icons';
import { CollapsibleCard } from "@/components/Common/CollapsibleCard";
import { getBlinkoraEndpoint } from "@/lib/blinkoraEndpoint";
import { downloadFromLink } from "@/lib/browserRuntime";
import { UserStore } from "@/store/user";
import { WorkspaceStore } from "@/store/workspace";
import { localizeErrorMessage } from "@/lib/errorMessage";

export const ExportSetting = observer(() => {
  const { t } = useTranslation();
  const user = RootStore.Get(UserStore);
  const workspaceStore = RootStore.Get(WorkspaceStore);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const [exportFormat, setExportFormat] = useState<'markdown' | 'json'>("markdown");
  const [exportScope, setExportScope] = useState<'workspace' | 'full'>("workspace");
  const [importMode, setImportMode] = useState<'workspace' | 'full'>("workspace");
  const [isImporting, setIsImporting] = useState(false);

  const [dateRange, setDateRange] = useState<{
    start: any;
    end: any;
  }>({
    start: null,
    end: null
  });
  const [focusedValue, setFocusedValue] = useState(today(getLocalTimeZone()));

  const formatOptions = [
    { label: t('markdown-backup-archive'), value: "markdown" },
    { label: t('json-backup-archive'), value: "json" }
  ];

  const exportScopeOptions = [
    { label: t('current-workspace-export'), value: "workspace" },
    { label: t('full-backup-export'), value: "full" }
  ];

  const importModeOptions = [
    { label: t('import-workspace'), value: "workspace" },
    { label: t('full-restore'), value: "full" }
  ];

  const handleExport = async () => {
    RootStore.Get(ToastPlugin).loading(t('exporting'), { id: 'exporting' })
    const exportParams: any = {
      baseURL: window.location.origin,
      format: exportFormat,
      scope: exportScope
    };

    if (dateRange.start && dateRange.end) {
      exportParams.startDate = new Date(dateRange.start.toString());
      exportParams.endDate = new Date(dateRange.end.toString());
    }
    try {
      const res = await PromiseCall(api.task.exportMarkdown.mutate(exportParams));
      RootStore.Get(ToastPlugin).dismiss('exporting')
      if (res?.downloadUrl) {
        downloadFromLink(getBlinkoraEndpoint(res.downloadUrl));
      }
    } catch (error: any) {
      RootStore.Get(ToastPlugin).dismiss('exporting')
      RootStore.Get(ToastPlugin).error(localizeErrorMessage(error))
    }
  };

  const handleImport = async (file?: File) => {
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.zip')) {
      RootStore.Get(ToastPlugin).error(t('backup-file-must-be-zip'));
      return;
    }

    const formData = new FormData();
    formData.append('mode', importMode);
    formData.append('file', file);

    setIsImporting(true);
    RootStore.Get(ToastPlugin).loading(t('importing'), { id: 'importing' });
    try {
      const response = await fetch(getBlinkoraEndpoint('/api/backup/import'), {
        method: 'POST',
        headers: user.token ? { Authorization: `Bearer ${user.token}` } : undefined,
        body: formData,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || t('operation-failed'));
      }

      RootStore.Get(ToastPlugin).success(t('import-done'));
      await workspaceStore.list.call();
    } catch (error: any) {
      RootStore.Get(ToastPlugin).error(localizeErrorMessage(error));
    } finally {
      RootStore.Get(ToastPlugin).dismiss('importing');
      setIsImporting(false);
      if (importFileRef.current) importFileRef.current.value = '';
    }
  };

  return (
    <CollapsibleCard
      icon="tabler:file-export"
      title={t('backup-and-restore')}
    >
      <Card shadow="none" className="flex flex-col p-4 bg-background">
        <Item
          leftContent={<>{t('export-level')}</>}
          rightContent={
            <Select
              aria-label={t('export-level')}
              selectedKeys={[exportScope]}
              onChange={e => setExportScope(e.target.value as 'workspace' | 'full')}
              className="w-[220px]"
            >
              {exportScopeOptions.map((item) => (
                <SelectItem key={item.value}>{item.label}</SelectItem>
              ))}
            </Select>
          }
        />

        <Item
          leftContent={<>{t('backup-archive-format')}</>}
          rightContent={
            <Select
              aria-label={t('backup-archive-format')}
              selectedKeys={[exportFormat]}
              onChange={e => setExportFormat(e.target.value as 'markdown' | 'json')}
              className="w-[200px]"
            >
              {formatOptions.map((item) => (
                <SelectItem key={item.value}>{item.label}</SelectItem>
              ))}
            </Select>
          }
        />

        <Item
          leftContent={<>{t('time-range')}</>}
          rightContent={
            <Popover placement="bottom" classNames={{
              content: [
                "p-0 bg-transparent border-none shadow-none",
              ],
            }}>
              <PopoverTrigger>
                <Button variant="flat" >
                  {dateRange.start && dateRange.end ? (
                    `${dayjs(new Date(dateRange.start.toString())).format('YYYY-MM-DD')} ~ ${dayjs(new Date(dateRange.end.toString())).format('YYYY-MM-DD')}`
                  ) : t('all')}
                </Button>
              </PopoverTrigger>
              <PopoverContent>
                <div className="flex flex-col gap-2">
                  <RangeCalendar
                    className="bg-background"
                    value={dateRange.start && dateRange.end ? dateRange : undefined}
                    onChange={setDateRange}
                    focusedValue={focusedValue}
                    onFocusChange={setFocusedValue}
                  />
                </div>
              </PopoverContent>
            </Popover>
          }
        />


        <div className="flex justify-end">
          <Button
            className="mt-4"
            color="primary"
            onPress={handleExport}
            startContent={<Icon icon="system-uicons:arrow-top-right" width="24" height="24" />}
          >
            {t('export')}
          </Button>
        </div>

        <div className="my-4 h-px bg-default-200" />

        <Item
          leftContent={<>{t('import-mode')}</>}
          rightContent={
            <Select
              aria-label={t('import-mode')}
              selectedKeys={[importMode]}
              onChange={e => setImportMode(e.target.value as 'workspace' | 'full')}
              className="w-[220px]"
            >
              {importModeOptions.map((item) => (
                <SelectItem key={item.value}>{item.label}</SelectItem>
              ))}
            </Select>
          }
        />

        <div className="flex justify-end">
          <input
            ref={importFileRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            className="hidden"
            onChange={(event) => handleImport(event.target.files?.[0])}
          />
          <Button
            className="mt-4"
            color="primary"
            variant="flat"
            isLoading={isImporting}
            onPress={() => importFileRef.current?.click()}
            startContent={!isImporting && <Icon icon="tabler:file-import" width="24" height="24" />}
          >
            {t('import')}
          </Button>
        </div>

      </Card>
    </CollapsibleCard>
  );
});
