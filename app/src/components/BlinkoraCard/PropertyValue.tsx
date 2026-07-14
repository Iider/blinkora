import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type PropertyValueProps = {
  value: string;
};

/**
 * Renders a property value as compact Markdown.
 *
 * Property values are intentionally rendered without raw HTML. ReactMarkdown's
 * default URL transform also rejects unsafe link protocols before they reach
 * the anchor element.
 */
export const PropertyValue = ({ value }: PropertyValueProps) => (
  <ReactMarkdown
    skipHtml
    remarkPlugins={[remarkGfm]}
    components={{
      p: ({ children }) => <>{children}</>,
      a: ({ children, ...props }) => (
        <a
          {...props}
          className="text-primary underline decoration-primary/60 underline-offset-2 transition-opacity hover:opacity-80"
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      ),
    }}
  >
    {value}
  </ReactMarkdown>
);
