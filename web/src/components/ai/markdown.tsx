"use client"

import * as React from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"
import { cn } from "@/lib/utils"

// Project doesn't ship @tailwindcss/typography, so every prose-* class is a
// no-op. We render each markdown node ourselves with design-token-aware
// classes so headings / lists / tables / code all match the rest of the app.
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("ai-md text-sm leading-relaxed text-foreground", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={MD_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

const MD_COMPONENTS: Components = {
  h1: ({ className, ...p }) => (
    <h1
      className={cn(
        "scroll-m-20 text-xl font-semibold tracking-tight mt-4 mb-2 first:mt-0",
        className,
      )}
      {...p}
    />
  ),
  h2: ({ className, ...p }) => (
    <h2
      className={cn(
        "scroll-m-20 text-lg font-semibold tracking-tight mt-4 mb-2 first:mt-0 border-b border-border/60 pb-1",
        className,
      )}
      {...p}
    />
  ),
  h3: ({ className, ...p }) => (
    <h3
      className={cn(
        "scroll-m-20 text-base font-semibold tracking-tight mt-3 mb-1.5 first:mt-0",
        className,
      )}
      {...p}
    />
  ),
  h4: ({ className, ...p }) => (
    <h4
      className={cn(
        "scroll-m-20 text-sm font-semibold tracking-tight mt-3 mb-1 first:mt-0",
        className,
      )}
      {...p}
    />
  ),
  h5: ({ className, ...p }) => (
    <h5
      className={cn("text-sm font-semibold mt-2 mb-1 first:mt-0", className)}
      {...p}
    />
  ),
  h6: ({ className, ...p }) => (
    <h6
      className={cn(
        "text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-2 mb-1 first:mt-0",
        className,
      )}
      {...p}
    />
  ),
  p: ({ className, ...p }) => (
    <p className={cn("my-2 leading-relaxed first:mt-0 last:mb-0", className)} {...p} />
  ),
  a: ({ className, ...p }) => (
    <a
      className={cn(
        "text-primary underline-offset-4 hover:underline break-words",
        className,
      )}
      target="_blank"
      rel="noreferrer noopener"
      {...p}
    />
  ),
  strong: ({ className, ...p }) => (
    <strong className={cn("font-semibold", className)} {...p} />
  ),
  em: ({ className, ...p }) => (
    <em className={cn("italic", className)} {...p} />
  ),
  ul: ({ className, ...p }) => (
    <ul className={cn("my-2 ml-5 list-disc space-y-1 marker:text-muted-foreground", className)} {...p} />
  ),
  ol: ({ className, ...p }) => (
    <ol className={cn("my-2 ml-5 list-decimal space-y-1 marker:text-muted-foreground", className)} {...p} />
  ),
  li: ({ className, ...p }) => (
    <li className={cn("leading-relaxed pl-1", className)} {...p} />
  ),
  blockquote: ({ className, ...p }) => (
    <blockquote
      className={cn(
        "my-3 border-l-2 border-primary/60 bg-muted/50 rounded-r py-1 pl-3 pr-3 text-foreground/90 italic",
        className,
      )}
      {...p}
    />
  ),
  hr: ({ className, ...p }) => (
    <hr className={cn("my-4 border-border", className)} {...p} />
  ),
  code: ({ className, children, ...p }) => {
    // react-markdown calls this both for inline code and the inner <code> of
    // <pre><code class="language-x">. We render inline differently; the block
    // case is handled by the outer <pre> component which passes the child code
    // through unchanged styles.
    const isBlock = typeof className === "string" && className.startsWith("language-")
    if (isBlock) {
      return (
        <code className={cn(className, "font-mono")} {...p}>
          {children}
        </code>
      )
    }
    return (
      <code
        className={cn(
          "rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground border border-border/60",
          className,
        )}
        {...p}
      >
        {children}
      </code>
    )
  },
  pre: ({ className, children, ...p }) => (
    <pre
      className={cn(
        "my-3 overflow-x-auto rounded-md border border-border/60 bg-muted p-3 text-xs leading-relaxed",
        className,
      )}
      {...p}
    >
      {children}
    </pre>
  ),
  table: ({ className, children, ...p }) => (
    <div className="my-3 overflow-x-auto rounded-md border border-border/60 bg-card">
      <table
        className={cn("w-full text-xs border-collapse caption-bottom", className)}
        {...p}
      >
        {children}
      </table>
    </div>
  ),
  thead: ({ className, ...p }) => (
    <thead className={cn("bg-muted/70", className)} {...p} />
  ),
  tbody: ({ className, ...p }) => (
    <tbody className={cn("[&_tr:last-child]:border-0", className)} {...p} />
  ),
  tr: ({ className, ...p }) => (
    <tr
      className={cn(
        "border-b border-border/40 transition-colors hover:bg-muted/30",
        className,
      )}
      {...p}
    />
  ),
  th: ({ className, ...p }) => (
    <th
      className={cn(
        "px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap",
        className,
      )}
      {...p}
    />
  ),
  td: ({ className, ...p }) => (
    <td
      className={cn("px-3 py-2 align-top break-words", className)}
      {...p}
    />
  ),
  img: ({ className, alt, ...p }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={alt || ""}
      className={cn("my-2 max-w-full rounded-md border border-border/60", className)}
      {...p}
    />
  ),
}
