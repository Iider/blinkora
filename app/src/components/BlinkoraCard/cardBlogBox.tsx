import { Note } from '@shared/lib/types';
import { helper } from '@/lib/helper';
import { RootStore } from '@/store/root';
import { useNavigate } from 'react-router-dom';
import { BlinkoraStore } from '@/store/blinkoraStore';
import { useMemo } from 'react';
import { buildPreviewLines, findPreviewTitle, type PreviewLine } from './cardPreview';

interface BlogContentProps {
  blinkoraItem: Note & {
    isBlog?: boolean;
    title?: string;
  };
  isExpanded?: boolean;
}

const PreviewItem = ({ line }: { line: PreviewLine }) => {
  if (line.kind === 'heading') {
    return (
      <div className="text-default-700 text-sm font-semibold leading-6 line-clamp-1">
        {line.text}
      </div>
    );
  }

  if (line.kind === 'bullet') {
    return (
      <div className="flex gap-2 text-desc text-sm leading-6">
        <span className="mt-[0.65em] h-1.5 w-1.5 rounded-full bg-default-400 flex-none" />
        <span className="line-clamp-1">{line.text}</span>
      </div>
    );
  }

  if (line.kind === 'quote') {
    return (
      <div className="border-l-2 border-default-300 pl-2 text-desc text-sm leading-6 line-clamp-2">
        {line.text}
      </div>
    );
  }

  return (
    <div className="text-desc text-sm leading-6 line-clamp-2">
      {line.text}
    </div>
  );
};

export const CardBlogBox = ({ blinkoraItem, isExpanded }: BlogContentProps) => {
  const navigate = useNavigate();
  const title = useMemo(() => {
    return findPreviewTitle(blinkoraItem.content, blinkoraItem.title);
  }, [blinkoraItem.content, blinkoraItem.title]);
  const previewLines = useMemo(() => {
    return buildPreviewLines(blinkoraItem.content, title, isExpanded);
  }, [blinkoraItem.content, title, isExpanded]);

  return (
    <div className={`flex items-start gap-2 mt-4 w-full mb-4`}>
      <div
        className='blog-content flex flex-col gap-2 pr-2'
        style={{
          width: '100%'
        }}
      >
        <div className={`font-bold leading-snug line-clamp-2 ${isExpanded ? 'text-lg' : 'text-md'}`}>
          {title}
        </div>

        <div className="flex flex-col gap-1">
          {previewLines.map((line, index) => (
            <PreviewItem key={`${line.kind}-${index}-${line.text}`} line={line} />
          ))}
        </div>

        {
          !!blinkoraItem?.tags?.length && blinkoraItem?.tags?.length > 0 && (
            <div className='flex flex-nowrap gap-1 overflow-x-scroll pt-1 hide-scrollbar'>
              {(() => {
                const tagTree = helper.buildHashTagTreeFromDb(
                  blinkoraItem.tags.map(tagItem => tagItem?.tag ?? tagItem)
                );
                const tagPaths = tagTree.flatMap(node => helper.generateTagPaths(node));
                const uniquePaths = tagPaths.filter(path => {
                  return !tagPaths.some(otherPath =>
                    otherPath !== path && otherPath.startsWith(path + '/')
                  );
                });
                return uniquePaths.map((path) => (
                  <div key={path} className='text-desc text-xs blinkora-tag whitespace-nowrap font-bold hover:opacity-80 !transition-all cursor-pointer' onClick={(e) => {
                    e.stopPropagation()
                    navigate(`/?path=all&searchText=${encodeURIComponent("#" + path)}`)
                    RootStore.Get(BlinkoraStore).forceQuery++
                  }}>
                    #{path}
                  </div>
                ));
              })()}
            </div>
          )}
      </div>
    </div>
  );
};
