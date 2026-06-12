export const ARTICLE_PREVIEW_LINE_LIMIT_MIN = 1;
export const ARTICLE_PREVIEW_LINE_LIMIT_MAX = 12;
export const DEFAULT_ARTICLE_PREVIEW_LINE_LIMIT = 5;
export const EXPANDED_ARTICLE_PREVIEW_LINE_LIMIT = 8;

export const normalizeArticlePreviewLineLimit = (value: unknown) => {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number.parseInt(value, 10)
      : DEFAULT_ARTICLE_PREVIEW_LINE_LIMIT;

  if (!Number.isFinite(parsed)) return DEFAULT_ARTICLE_PREVIEW_LINE_LIMIT;
  return Math.min(
    ARTICLE_PREVIEW_LINE_LIMIT_MAX,
    Math.max(ARTICLE_PREVIEW_LINE_LIMIT_MIN, Math.trunc(parsed))
  );
};
