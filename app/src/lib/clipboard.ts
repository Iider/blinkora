const copyWithCommand = (content: string) => {
  const textarea = document.createElement('textarea');
  textarea.value = content;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);

  try {
    textarea.focus();
    textarea.select();
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
};

export const writeTextToClipboard = async (content: string) => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(content);
      return;
    } catch {
      // Some browser contexts expose Clipboard API but deny writes.
    }
  }

  if (!copyWithCommand(content)) {
    throw new Error('Failed to copy text to clipboard');
  }
};
