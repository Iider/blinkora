import { observer } from "mobx-react-lite";
import { Button, Card, Chip, Input, Select, SelectItem, Spinner, Switch } from "@heroui/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import dayjs from "@/lib/dayjs";
import { api } from "@/lib/trpc";
import { RootStore } from "@/store";
import { BlinkoraStore } from "@/store/blinkoraStore";
import { PromiseCall } from "@/store/standard/PromiseState";
import { CollapsibleCard } from "@/components/Common/CollapsibleCard";
import { Icon } from "@/components/Common/Iconify/icons";
import { NoteType } from "@shared/lib/types";

const DEFAULT_LOGGED_NOTE_TYPES = [NoteType.NOTE];

const NOTE_TYPE_OPTIONS = [
  { value: NoteType.BLINKORA, labelKey: "blinkora" },
  { value: NoteType.NOTE, labelKey: "note" },
  { value: NoteType.TODO, labelKey: "todo" },
];

const ACTION_OPTIONS = [
  "create",
  "update",
  "archive",
  "unarchive",
  "recycle",
  "restore",
  "markDailyReviewed",
  "markDailyUnreviewed",
  "delete",
  "addReference",
  "removeReference",
  "setReferences",
  "tagUpdate",
  "tagDeleteWithNotes",
];

const FIELD_OPTIONS = ["content", "type", "metadata", "tags", "references", "flags", "note"];

const selectionValue = (keys: any, fallback = "all") => {
  const first = Array.from(keys || [])[0];
  return first ? String(first) : fallback;
};

export const OperationLogSetting = observer(() => {
  const { t } = useTranslation();
  const blinkora = RootStore.Get(BlinkoraStore);
  const [actorType, setActorType] = useState("all");
  const [noteType, setNoteType] = useState("all");
  const [action, setAction] = useState("all");
  const [changedField, setChangedField] = useState("all");
  const [noteId, setNoteId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);

  const enabledNoteTypes = useMemo(() => {
    const value = blinkora.config.value?.operationLogNoteTypes;
    return new Set(Array.isArray(value) ? value : DEFAULT_LOGGED_NOTE_TYPES);
  }, [blinkora.config.value?.operationLogNoteTypes]);

  const loadLogs = async () => {
    setIsLoading(true);
    try {
      const params: any = {
        page,
        size: 30,
        orderBy: "desc",
      };
      if (actorType !== "all") params.actorType = actorType;
      if (noteType !== "all") params.noteTypes = [Number(noteType)];
      if (action !== "all") params.actions = [action];
      if (changedField !== "all") params.changedField = changedField;
      if (noteId.trim()) params.noteId = Number(noteId.trim());
      if (startDate) params.startDate = new Date(startDate).toISOString();
      if (endDate) params.endDate = new Date(endDate).toISOString();
      const next = await api.operationLogs.list.query(params);
      setResult(next);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadLogs();
  }, [actorType, noteType, action, changedField, noteId, startDate, endDate, page]);

  const toggleNoteType = async (type: NoteType, enabled: boolean) => {
    const next = new Set(enabledNoteTypes);
    if (enabled) {
      next.add(type);
    } else {
      next.delete(type);
    }
    await PromiseCall(api.config.update.mutate({
      key: "operationLogNoteTypes",
      value: Array.from(next).sort((a, b) => a - b),
    }), { autoAlert: false });
    await blinkora.config.call();
  };

  const resetPage = (setter: (value: string) => void) => (value: string) => {
    setPage(1);
    setter(value);
  };

  const items = result?.items ?? [];
  const total = Number(result?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / 30));

  return (
    <CollapsibleCard icon="lucide:history" title={t("operation-log")}>
      <Card shadow="none" className="flex flex-col gap-4 p-4 bg-background">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {NOTE_TYPE_OPTIONS.map((item) => (
            <div key={item.value} className="flex items-center justify-between rounded-lg border border-default-200 px-3 py-2">
              <span className="text-sm font-semibold">{t(`operation-log-record-${item.labelKey}`)}</span>
              <Switch
                size="sm"
                isSelected={enabledNoteTypes.has(item.value)}
                onValueChange={(selected) => toggleNoteType(item.value, selected)}
              />
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Select data-operation-log-actor-trigger="true" size="sm" label={t("operator")} selectedKeys={[actorType]} onSelectionChange={(keys) => resetPage(setActorType)(selectionValue(keys))}>
            <SelectItem key="all">{t("all")}</SelectItem>
            <SelectItem key="user">{t("operation-log-actor-user")}</SelectItem>
            <SelectItem key="agent">{t("operation-log-actor-agent")}</SelectItem>
            <SelectItem key="system">{t("operation-log-actor-system")}</SelectItem>
          </Select>
          <Select data-operation-log-note-type-trigger="true" size="sm" label={t("note-type")} selectedKeys={[noteType]} onSelectionChange={(keys) => resetPage(setNoteType)(selectionValue(keys))}>
            <SelectItem key="all">{t("all")}</SelectItem>
            <>
              {NOTE_TYPE_OPTIONS.map((item) => (
                <SelectItem key={String(item.value)}>{t(item.labelKey)}</SelectItem>
              ))}
            </>
          </Select>
          <Select data-operation-log-action-trigger="true" size="sm" label={t("operation-log-action")} selectedKeys={[action]} onSelectionChange={(keys) => resetPage(setAction)(selectionValue(keys))}>
            <SelectItem key="all">{t("all")}</SelectItem>
            <>
              {ACTION_OPTIONS.map((item) => (
                <SelectItem key={item}>{t(`operation-log-action-${item}`)}</SelectItem>
              ))}
            </>
          </Select>
          <Select data-operation-log-field-trigger="true" size="sm" label={t("operation-log-field")} selectedKeys={[changedField]} onSelectionChange={(keys) => resetPage(setChangedField)(selectionValue(keys))}>
            <SelectItem key="all">{t("all")}</SelectItem>
            <>
              {FIELD_OPTIONS.map((item) => (
                <SelectItem key={item}>{t(`operation-log-field-${item}`)}</SelectItem>
              ))}
            </>
          </Select>
          <Input size="sm" label={t("note-id")} value={noteId} onValueChange={resetPage(setNoteId)} />
          <div className="flex gap-2">
            <Input size="sm" type="datetime-local" label={t("start-time")} value={startDate} onValueChange={resetPage(setStartDate)} />
            <Input size="sm" type="datetime-local" label={t("end-time")} value={endDate} onValueChange={resetPage(setEndDate)} />
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="text-sm text-default-500">{t("operation-log-total", { count: total })}</div>
          <Button size="sm" variant="flat" startContent={<Icon icon="lucide:refresh-cw" width="16" />} onPress={loadLogs}>
            {t("refresh")}
          </Button>
        </div>

        <div className="flex flex-col divide-y divide-default-100 rounded-lg border border-default-100">
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <Spinner size="sm" />
            </div>
          )}
          {!isLoading && items.length === 0 && (
            <div className="py-8 text-center text-sm text-default-500">{t("no-data")}</div>
          )}
          {!isLoading && items.map((item: any) => (
            <div key={item.id} className="flex flex-col gap-2 px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Chip size="sm" variant="flat">{t(`operation-log-action-${item.action}`)}</Chip>
                <span className="text-sm font-semibold break-all">{item.target?.title || `#${item.target?.noteId}`}</span>
                <span className="text-xs text-default-500">#{item.target?.noteId ?? "-"}</span>
                <span className="ml-auto text-xs text-default-500">{dayjs(item.createdAt).format("YYYY-MM-DD HH:mm:ss")}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-default-500">
                <span>{item.actor?.label}</span>
                <span>{t(`operation-log-actor-${item.actor?.type || "user"}`)}</span>
                {(item.changedFields || []).map((field: string) => (
                  <Chip key={field} size="sm" variant="bordered">{t(`operation-log-field-${field}`)}</Chip>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="flat" isDisabled={page <= 1 || isLoading} onPress={() => setPage((value) => Math.max(1, value - 1))}>
            {t("previous-page")}
          </Button>
          <span className="text-sm text-default-500">{page} / {totalPages}</span>
          <Button size="sm" variant="flat" isDisabled={page >= totalPages || isLoading} onPress={() => setPage((value) => value + 1)}>
            {t("next-page")}
          </Button>
        </div>
      </Card>
    </CollapsibleCard>
  );
});
