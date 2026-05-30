import { useState, useEffect } from 'react';
import {
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem
} from "@heroui/dropdown";
import { Button, Spinner } from '@heroui/react';
import { Icon } from '@/components/Common/Iconify/icons';
import { api } from '@/lib/trpc';
import { FontManager, FontMetadata } from '@/lib/fontManager';
import { useTranslation } from 'react-i18next';

interface FontSwitcherProps {
  fontname?: string;
  onChange?: (fontname: string) => void;
}

const FontSwitcher = ({ fontname = 'default', onChange }: FontSwitcherProps) => {
  const { t } = useTranslation();
  const [fonts, setFonts] = useState<FontMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingFont, setLoadingFont] = useState<string | null>(null);

  useEffect(() => {
    const fetchFonts = async () => {
      try {
        if (!api.fonts) {
          throw new Error('Font API not available');
        }
        const fontList = await api.fonts.list.query();
        setFonts(fontList);
        FontManager.initializeRegistry(fontList);
      } catch (error) {
        console.error('Failed to fetch fonts:', error);
        setFonts([
          { id: 0, name: 'default', displayName: t('default-system-font'), url: null, isLocal: false, weights: [400], category: 'sans-serif', isSystem: true, sortOrder: 0 }
        ]);
      } finally {
        setLoading(false);
      }
    };

    fetchFonts();
  }, [t]);

  useEffect(() => {
    if (fontname && fontname !== 'default' && fonts.length > 0) {
      FontManager.applyFont(fontname).catch((error) => {
        console.warn('Failed to apply font on mount:', error);
      });
    }
  }, [fontname, fonts]);

  const handleFontSelect = async (selectedFont: string) => {
    if (selectedFont === fontname) return;

    setLoadingFont(selectedFont);

    try {
      await FontManager.applyFont(selectedFont);
      onChange?.(selectedFont);
    } catch (error) {
      console.error('Failed to apply font:', error);
    } finally {
      setLoadingFont(null);
    }
  };

  const getFontDisplayName = (font: FontMetadata) => font.isSystem && font.name === 'default'
    ? t('default-system-font')
    : font.displayName;
  const currentFont = fonts.find(f => f.name === fontname);

  if (loading) {
    return (
      <Button variant="flat" isLoading>
        {t('loading')}
      </Button>
    );
  }

  return (
    <Dropdown>
      <DropdownTrigger>
        <Button variant="flat">
          {currentFont ? getFontDisplayName(currentFont) : fontname || t('select-font')}
        </Button>
      </DropdownTrigger>

      <DropdownMenu
        className="p-2 max-h-[400px] overflow-y-auto"
        aria-label={t('select-font')}
      >
        {fonts.map((font) => (
          <DropdownItem
            key={font.name}
            className="flex items-center justify-between cursor-pointer"
            onClick={() => handleFontSelect(font.name)}
            endContent={
              loadingFont === font.name ? (
                <Spinner size="sm" />
              ) : fontname === font.name ? (
                <Icon icon="mingcute:check-fill" width="18" height="18" />
              ) : null
            }
          >
            <span
              style={{
                fontFamily: font.isSystem ? undefined : `"${font.name}", ${font.category}`
              }}
            >
              {getFontDisplayName(font)}
            </span>
          </DropdownItem>
        ))}
      </DropdownMenu>
    </Dropdown>
  );
};

export default FontSwitcher;
