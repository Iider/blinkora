import type { Note } from '@shared/lib/types';
import { stringifyNotePropertiesYaml } from '@/lib/noteProperties';
import { findPreviewTitle } from './cardPreview';

const MAX_FILENAME_CHARS = 80;

const sanitizeFilenamePart = (value: string) => {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');

  return Array.from(sanitized).slice(0, MAX_FILENAME_CHARS).join('').trim();
};

export const buildNoteMarkdownContent = (note: Note) => {
  const content = note.content ?? '';
  const propertiesYaml = stringifyNotePropertiesYaml(note.metadata?.properties);

  if (!propertiesYaml) return content;
  return `---\n${propertiesYaml}\n---\n\n${content}`;
};

export const buildNoteMarkdownFilename = (note: Note) => {
  const title = findPreviewTitle(note.content ?? '', note.title ?? '');
  const baseName = sanitizeFilenamePart(title) || (note.id ? `note-${note.id}` : 'note');

  return `${baseName}.md`;
};

export const downloadNoteMarkdown = (note: Note) => {
  const blob = new Blob([buildNoteMarkdownContent(note)], { type: 'text/markdown;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');

  try {
    link.href = url;
    link.download = buildNoteMarkdownFilename(note);
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
  }
};
