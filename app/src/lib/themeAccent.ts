export const applyThemeAccent = (themeColor?: string | null, themeForegroundColor?: string | null) => {
  const root = document.documentElement;
  const color = themeColor?.trim();
  const foreground = themeForegroundColor?.trim();

  if (color && foreground) {
    root.style.setProperty('--primary', color);
    root.style.setProperty('--primary-foreground', foreground);
    return;
  }

  root.style.removeProperty('--primary');
  root.style.removeProperty('--primary-foreground');
};
