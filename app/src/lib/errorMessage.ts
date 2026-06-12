import i18n from "@/lib/i18n";

const exactErrorKeys: Record<string, string> = {
  "Unauthorized": "error.unauthorized",
  "Forbidden": "error.forbidden",
  "Not found": "error.not-found",
  "workspace not found": "error.workspace-not-found",
  "Workspace not found": "error.workspace-not-found",
  "invalid workspace": "error.invalid-workspace",
  "Note not found": "error.note-not-found",
  "note not found": "error.note-not-found",
  "one or more notes were not found in this workspace": "error.notes-not-found-in-workspace",
  "one or more referenced notes were not found in this workspace": "error.referenced-notes-not-found-in-workspace",
  "Some notes cannot be deleted as you are not the owner": "error.not-note-owner",
  "note id is required": "error.note-id-required",
  "invalid reference": "error.invalid-reference",
  "id or fromNoteId/toNoteId is required": "error.reference-id-required",
  "fromNoteId is required": "error.from-note-id-required",
  "Agent token cannot modify attachments": "error.agent-token-cannot-modify-attachments",
  "Agent token cannot manage agent tokens": "error.agent-token-cannot-manage-tokens",
  "Agent token is not allowed for this endpoint": "error.agent-token-not-allowed",
  "Invalid token": "error.invalid-token",
  "name is required": "error.name-required",
  "id is required": "error.id-required",
  "key is required": "error.key-required",
  "workspaceId is required": "error.workspace-id-required",
  "old folder path is required": "error.old-folder-path-required",
  "File names cannot contain path separators": "error.file-name-cannot-contain-path-separators",
  "Attachment not found": "error.attachment-not-found",
  "Attachments not found": "error.attachments-not-found",
  "File not found": "error.file-not-found",
  "No files received.": "error.no-files-received",
  "No URL provided": "error.no-url-provided",
  "Failed to fetch file from URL": "error.fetch-file-from-url-failed",
  "Only superadmin can access": "error.only-superadmin-can-access",
  "Error checking file permissions": "error.file-permission-check-failed",
  "Invalid path characters": "error.invalid-path-characters",
  "Invalid path": "error.invalid-path",
  "Access denied": "error.access-denied",
  "tag not found": "error.tag-not-found",
  "token not found": "error.token-not-found",
  "font not found": "error.font-not-found",
  "invalid font file data": "error.invalid-font-file-data",
  "Font file is empty": "error.font-file-empty",
  "Font file too large. Maximum size is 10MB": "error.font-file-too-large",
  "Unauthorized: Only superadmin can manage fonts": "error.only-superadmin-can-manage-fonts",
  "invalid font category": "error.invalid-font-category",
  "reply parent must belong to the same note": "error.reply-parent-must-belong-to-same-note",
  "annotation not found": "error.annotation-not-found",
  "You are not allowed to update global config": "error.global-config-not-allowed",
  "cannot delete default workspace": "error.cannot-delete-default-workspace",
  "User not found": "error.user-not-found",
  "user not found": "error.user-not-found",
  "Invalid username or password": "error.invalid-username-or-password",
  "password is incorrect": "error.password-incorrect",
  "original password is incorrect": "error.original-password-incorrect",
  "invalid verification code": "error.invalid-verification-code",
  "account not found": "error.account-not-found",
  "registration is closed for single-account mode": "error.registration-closed",
  "Unsupported provider": "error.unsupported-provider",
  "Login failed": "login-failed",
  "S3 config not found": "error.s3-config-not-found",
  "Invalid S3 path": "error.invalid-s3-path",
  "Invalid file path": "error.invalid-file-path",
  "Endpoint is required": "error.endpoint-required",
  "Endpoint must be a valid URL": "error.endpoint-invalid-url",
  "Region ID is required": "error.region-required",
  "Bucket is required": "error.bucket-required",
  "Access Key is required": "error.access-key-required",
  "Secret Key is required": "error.secret-key-required",
  "Custom Path contains an invalid path segment": "error.custom-path-invalid-segment",
  "backup file is required": "error.backup-file-required",
  "unsupported import mode": "error.unsupported-import-mode",
  "unsupported backup schema": "error.unsupported-backup-schema",
  "invalid backup manifest": "error.invalid-backup-manifest",
  "unsupported export format": "error.unsupported-export-format",
  "unsupported export scope": "error.unsupported-export-scope",
  "backup manifest not found": "error.backup-manifest-not-found",
  "Azure embedding baseURL is required": "error.azure-embedding-base-url-required",
  "embedding response does not include vectors": "error.embedding-response-missing-vectors",
  "PromisePageState function must return array": "error.promise-page-state-array-required",
  "Failed to fetch": "error.network-request-failed",
  "NetworkError when attempting to fetch resource.": "error.network-request-failed",
  "The operation was aborted.": "error.request-timeout",
  "Unknown error": "error.unknown",
};

const actionLabels: Record<string, string> = {
  "delete S3 object": "error.action-delete-s3-object",
  "delete workspace attachment": "error.action-delete-workspace-attachment",
};

export const getRawErrorMessage = (error: unknown): string => {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object") {
    const maybeMessage = (error as { message?: unknown; error?: unknown }).message;
    if (typeof maybeMessage === "string") return maybeMessage;
    const maybeError = (error as { message?: unknown; error?: unknown }).error;
    if (typeof maybeError === "string") return maybeError;
  }
  return "";
};

const normalizeErrorMessage = (message: string): string => {
  return message
    .trim()
    .replace(/^TRPCClientError:\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
};

const hasChinese = (message: string): boolean => /[\u4e00-\u9fff]/.test(message);

const isEnglishLocale = (): boolean => {
  const language = i18n.resolvedLanguage || i18n.language || "";
  return language.toLowerCase().startsWith("en");
};

const translatedFieldLabel = (field: string): string => {
  const key = `error.field.${field.trim()}`;
  const translated = i18n.t(key);
  return translated === key ? field : translated;
};

const translatedActionLabel = (action: string): string => {
  const key = actionLabels[action.trim()];
  if (!key) return action;
  const translated = i18n.t(key);
  return translated === key ? action : translated;
};

export const isUnauthorizedError = (error: unknown): boolean => {
  const message = normalizeErrorMessage(getRawErrorMessage(error));
  return message === "Unauthorized";
};

export const localizeErrorMessage = (
  error: unknown,
  fallbackKey: string = "operation-failed",
): string => {
  const rawMessage = getRawErrorMessage(error);
  const message = normalizeErrorMessage(rawMessage);

  if (!message) return i18n.t(fallbackKey);

  const exactKey = exactErrorKeys[message];
  if (exactKey) return i18n.t(exactKey);

  const notFoundMatch = message.match(/^Not found:\s*(.+)$/);
  if (notFoundMatch) {
    return i18n.t("error.not-found-with-detail", { detail: notFoundMatch[1] });
  }

  const unknownToolMatch = message.match(/^Unknown tool:\s*(.+)$/);
  if (unknownToolMatch) {
    return i18n.t("error.unknown-tool", { tool: unknownToolMatch[1] });
  }

  const requiredMatch = message.match(/^(.+)\s+is required$/);
  if (requiredMatch) {
    return i18n.t("error.field-required", {
      field: translatedFieldLabel(requiredMatch[1]),
    });
  }

  const s3ValidationMatch = message.match(/^S3 validation failed\. Tried\s+(.+)$/);
  if (s3ValidationMatch) {
    if (!isEnglishLocale()) return i18n.t("error.s3-validation-failed");
    return i18n.t("error.s3-validation-failed-with-detail", {
      detail: s3ValidationMatch[1],
    });
  }

  const getObjectMatch = message.match(/^get object failed with HTTP\s+(.+)$/);
  if (getObjectMatch) {
    return i18n.t("error.s3-get-object-failed", { status: getObjectMatch[1] });
  }

  const actionHttpMatch = message.match(/^(.+)\s+failed with HTTP\s+(.+)$/);
  if (actionHttpMatch) {
    return i18n.t("error.action-http-failed", {
      action: translatedActionLabel(actionHttpMatch[1]),
      status: actionHttpMatch[2],
    });
  }

  const embeddingProviderMatch = message.match(/^embedding provider returned\s+(.+)$/);
  if (embeddingProviderMatch) {
    if (!isEnglishLocale()) return i18n.t("error.embedding-provider-failed");
    return i18n.t("error.embedding-provider-returned", {
      detail: embeddingProviderMatch[1],
    });
  }

  if (hasChinese(message) || isEnglishLocale()) return message;

  return i18n.t(fallbackKey);
};
