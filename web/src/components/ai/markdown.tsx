"use client"

import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"

export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert
      prose-pre:bg-muted prose-pre:text-foreground prose-pre:border prose-pre:border-border/60 prose-pre:rounded-md
      prose-code:bg-muted prose-code:text-foreground prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:before:hidden prose-code:after:hidden prose-code:font-normal
      prose-pre:[&_code]:bg-transparent prose-pre:[&_code]:p-0 prose-pre:[&_code]:rounded-none
      prose-a:text-primary prose-a:no-underline hover:prose-a:underline
      prose-headings:font-semibold prose-headings:tracking-tight
      prose-hr:border-border
      prose-blockquote:border-l-primary prose-blockquote:bg-muted/40 prose-blockquote:py-1 prose-blockquote:rounded-r
    ">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
