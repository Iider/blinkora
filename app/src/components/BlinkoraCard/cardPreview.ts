export type PreviewLine = {
  kind: 'heading' | 'bullet' | 'paragraph' | 'quote';
  text: string;
};

const hashTagOnlyRegex = /^#[^\s#]+$/;
const tableDividerRegex = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/;
const defaultFoldLength = 1000;

const truncateText = (value: string, maxLength: number) => {
  const chars = Array.from(value);
  if (chars.length <= maxLength) return value;
  return `${chars.slice(0, maxLength).join('').trimEnd()}...`;
};

const stripInlineMarkdown = (value: string) => value
  .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/__([^_]+)__/g, '$1')
  .replace(/\*([^*]+)\*/g, '$1')
  .replace(/_([^_]+)_/g, '$1')
  .replace(/~~([^~]+)~~/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const stripBlockPrefix = (value: string) => stripInlineMarkdown(value)
  .replace(/^\s{0,3}#{1,6}\s+/, '')
  .replace(/^\s{0,3}>\s?/, '')
  .replace(/^\s*[-*+]\s+/, '')
  .replace(/^\s*\d+[.)]\s+/, '')
  .replace(/^\s*\[[ xX]\]\s+/, '')
  .trim();

const isTagOnlyLine = (line: string) => {
  const parts = line.trim().split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every(part => hashTagOnlyRegex.test(part));
};

const isDividerLine = (line: string) => /^\s*[-*_]{3,}\s*$/.test(line.trim()) || tableDividerRegex.test(line.trim());

const eachReadableLine = (content: string = '', callback: (line: string) => boolean | void) => {
  let inCodeFence = false;
  let inFrontmatter = false;
  const lines = content.split('\n');

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index] ?? '';
    const trimmed = rawLine.trim();

    if (index === 0 && trimmed === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (trimmed === '---') inFrontmatter = false;
      continue;
    }
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence || !trimmed || isTagOnlyLine(trimmed) || isDividerLine(trimmed)) continue;

    if (callback(rawLine) === false) break;
  }
};

const eachFallbackLine = (content: string = '', callback: (line: string) => boolean | void) => {
  let inFrontmatter = false;
  const lines = content.split('\n');

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index] ?? '';
    const trimmed = rawLine.trim();

    if (index === 0 && trimmed === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (trimmed === '---') inFrontmatter = false;
      continue;
    }
    if (
      !trimmed ||
      trimmed.startsWith('```') ||
      trimmed.startsWith('~~~') ||
      isTagOnlyLine(trimmed) ||
      isDividerLine(trimmed)
    ) {
      continue;
    }

    if (callback(rawLine) === false) break;
  }
};

export const normalizePreviewText = (line: string) => stripBlockPrefix(line).replace(/#/g, '').trim();

export const findPreviewTitle = (content: string = '', fallbackTitle: string = '') => {
  const normalizedFallback = normalizePreviewText(fallbackTitle);
  if (normalizedFallback && normalizedFallback !== '---' && normalizedFallback !== '```' && normalizedFallback !== '~~~') {
    return normalizedFallback;
  }

  let title = '';
  eachReadableLine(content, (rawLine) => {
    const normalized = normalizePreviewText(rawLine);
    if (normalized) {
      title = normalized;
      return false;
    }
  });
  if (!title) {
    eachFallbackLine(content, (rawLine) => {
      const normalized = normalizePreviewText(rawLine);
      if (normalized) {
        title = normalized;
        return false;
      }
    });
  }
  return title;
};

export const shouldUseBlogPreview = (content: string = '', foldLength: number | null | undefined = defaultFoldLength) => {
  const safeFoldLength = typeof foldLength === 'number' && Number.isFinite(foldLength) && foldLength >= 0
    ? foldLength
    : defaultFoldLength;
  if (Array.from(content).length > safeFoldLength) return true;

  const lineThreshold = Math.max(8, Math.min(18, Math.ceil(safeFoldLength / 80)));
  let readableLines = 0;
  eachReadableLine(content, () => {
    readableLines += 1;
    return readableLines <= lineThreshold;
  });

  return readableLines > lineThreshold;
};

export const buildPreviewLines = (content: string = '', title: string = '', isExpanded?: boolean): PreviewLine[] => {
  const maxLines = isExpanded ? 8 : 5;
  const titleText = normalizePreviewText(title);
  const preview: PreviewLine[] = [];
  let skippedTitle = false;

  eachReadableLine(content, (rawLine) => {
    const trimmed = rawLine.trim();
    const normalized = normalizePreviewText(rawLine);
    if (!normalized) return;
    if (!skippedTitle && titleText && normalized === titleText) {
      skippedTitle = true;
      return;
    }

    const headingMatch = rawLine.match(/^\s{0,3}#{1,6}\s+(.+)$/);
    const bulletMatch = rawLine.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/);
    const quoteMatch = rawLine.match(/^\s{0,3}>\s?(.+)$/);

    if (headingMatch) {
      preview.push({ kind: 'heading', text: truncateText(normalized, isExpanded ? 96 : 54) });
    } else if (bulletMatch) {
      preview.push({ kind: 'bullet', text: truncateText(stripBlockPrefix(bulletMatch[1] ?? ''), isExpanded ? 120 : 72) });
    } else if (quoteMatch) {
      preview.push({ kind: 'quote', text: truncateText(stripBlockPrefix(quoteMatch[1] ?? ''), isExpanded ? 140 : 92) });
    } else if (trimmed.includes('|')) {
      const cells = trimmed.split('|').map(cell => normalizePreviewText(cell)).filter(Boolean);
      if (cells.length > 1) {
        preview.push({ kind: 'paragraph', text: truncateText(cells.join(' / '), isExpanded ? 140 : 92) });
      }
    } else {
      preview.push({ kind: 'paragraph', text: truncateText(normalized, isExpanded ? 150 : 96) });
    }

    return preview.length < maxLines;
  });

  if (preview.length === 0) {
    eachFallbackLine(content, (rawLine) => {
      const normalized = normalizePreviewText(rawLine);
      if (!normalized || normalized === titleText) return;
      preview.push({ kind: 'paragraph', text: truncateText(normalized, isExpanded ? 150 : 96) });
      return preview.length < maxLines;
    });
  }

  return preview;
};
