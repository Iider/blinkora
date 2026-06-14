import { Icon } from '@/components/Common/Iconify/icons';
import { NoteTypePicker } from '@/components/Common/NoteTypePicker';
import { NoteType } from '@shared/lib/types';
import { useEffect, useState } from 'react';

export const NoteTypeButton = ({ noteType, setNoteType }: {
  noteType: NoteType,
  setNoteType: (noteType: NoteType) => void
}) => {
  const [type, setType] = useState(noteType);

  useEffect(() => {
    setType(noteType);
  }, [noteType]);

  return (
    <div className='mr-[-2px]'>
      <NoteTypePicker
        value={type}
        onChange={(newType) => {
          setType(newType);
          setNoteType(newType);
        }}
        trigger={(option, label) => (
          <button
            type="button"
            title={label}
            aria-label={label}
            className="hover:bg-hover transition-colors duration-200 cursor-pointer rounded-md flex items-center justify-center w-[23px] h-[23px]"
          >
            <Icon icon={option.icon} className={option.iconClassName} width={20} height={20} />
          </button>
        )}
      />
    </div>
  );
};
