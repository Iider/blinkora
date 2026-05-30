export const SUPPORTED_LANGUAGES = [
  'zh',
  'en',
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const SUPPORTED_LANGUAGE_SET = new Set<string>(SUPPORTED_LANGUAGES);

export function normalizeLanguage(language?: string | null): SupportedLanguage {
  const code = String(language || 'zh').replace('_', '-').trim();
  const lowerCode = code.toLowerCase();

  if (lowerCode === 'en' || lowerCode.startsWith('en-')) {
    return 'en';
  }

  const exactMatch = SUPPORTED_LANGUAGES.find(item => item.toLowerCase() === lowerCode);
  if (exactMatch) {
    return exactMatch;
  }

  const baseLanguage = lowerCode.split('-')[0];
  if (SUPPORTED_LANGUAGE_SET.has(baseLanguage)) {
    return baseLanguage as SupportedLanguage;
  }

  return 'zh';
}
