"use client"

import * as React from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeHighlight from "rehype-highlight"
import rehypeKatex from "rehype-katex"
import { Check, Copy, Terminal } from "lucide-react"
import { toast } from "sonner"
import { MermaidBlock } from "./mermaid-block"
import { cn } from "@/lib/utils"

// KaTeX CSS is heavy (~80 KB) and only needed when math nodes exist. We
// lazy-inject the stylesheet at module level via a tiny <link> tag injected
// the first time Markdown mounts so every conversation page that uses math
// gets it without bundling it eagerly into the main chunk.
let katexCSSInjected = false
function ensureKatexCSS() {
  if (typeof window === "undefined") return
  if (katexCSSInjected) return
  katexCSSInjected = true
  const id = "katex-css"
  if (document.getElementById(id)) return
  const link = document.createElement("link")
  link.id = id
  link.rel = "stylesheet"
  link.href = "https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css"
  link.crossOrigin = "anonymous"
  document.head.appendChild(link)
}

// Project doesn't ship @tailwindcss/typography, so every prose-* class is a
// no-op. We render each markdown node ourselves with design-token-aware
// classes so headings / lists / tables / code all match the rest of the app.
//
// Bonus features:
//  - rehype-katex for $$x^2$$ math
//  - MermaidBlock for ```mermaid``` diagrams
//  - per-code-block copy + "fill composer" buttons (for shell snippets)
//
// onUseSnippet (optional): called when user clicks the "用到 composer" button
// on a shell code block; the conversation page pipes the text into draft.
export function Markdown({
  text,
  className,
  onUseSnippet,
}: {
  text: string
  className?: string
  onUseSnippet?: (snippet: string) => void
}) {
  React.useEffect(() => {
    ensureKatexCSS()
  }, [])
  const components = React.useMemo<Components>(
    () => buildComponents(onUseSnippet),
    [onUseSnippet],
  )
  return (
    <div className={cn("ai-md text-sm leading-relaxed text-foreground", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeHighlight, rehypeKatex]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function buildComponents(onUseSnippet?: (snippet: string) => void): Components {
  return {
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
    // <pre><code class="language-x">. Three cases here:
    //   1. ```mermaid``` → swap the <code> for our MermaidBlock entirely
    //   2. Any other fenced block → keep the structure; the outer <pre> adds toolbar
    //   3. Inline code → small pill
    const lang =
      typeof className === "string" && className.startsWith("language-")
        ? className.slice("language-".length).split(" ")[0]
        : ""
    if (lang === "mermaid") {
      const source = childrenToText(children)
      return <MermaidBlock source={source} />
    }
    if (lang) {
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
  pre: ({ className, children, ...p }) => {
    const lang = detectLang(children)
    if (lang === "mermaid") {
      // The MermaidBlock already replaced this; render the child raw.
      return <>{children}</>
    }
    const source = childrenToText(children)
    return (
      <CodeBlock
        className={className}
        lang={lang}
        source={source}
        onUseSnippet={onUseSnippet}
        rawProps={p}
      >
        {children}
      </CodeBlock>
    )
  },
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
}

// ---- code block toolbar + helpers ----

const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console"])

function CodeBlock({
  className,
  lang,
  source,
  onUseSnippet,
  rawProps,
  children,
}: {
  className?: string
  lang: string
  source: string
  onUseSnippet?: (snippet: string) => void
  rawProps: Record<string, unknown>
  children: React.ReactNode
}) {
  const [copied, setCopied] = React.useState(false)
  const isShell = SHELL_LANGS.has(lang.toLowerCase())

  async function doCopy() {
    try {
      await navigator.clipboard.writeText(source)
      setCopied(true)
      toast.success("已复制")
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error("复制失败")
    }
  }

  return (
    <div className="my-3 group relative overflow-hidden rounded-md border border-border/60 bg-muted">
      {(lang || isShell) && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40 bg-muted/60 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span className="font-mono">{lang || "code"}</span>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            {isShell && onUseSnippet && (
              <button
                type="button"
                onClick={() => onUseSnippet(source)}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-accent text-foreground"
                title="把这段命令填到 composer"
              >
                <Terminal className="w-3 h-3" />
                <span className="text-[10px] normal-case tracking-normal">填到输入框</span>
              </button>
            )}
            <button
              type="button"
              onClick={doCopy}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-accent text-foreground"
              title="复制"
            >
              {copied ? (
                <Check className="w-3 h-3" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
              <span className="text-[10px] normal-case tracking-normal">复制</span>
            </button>
          </div>
        </div>
      )}
      <pre
        className={cn(
          "overflow-x-auto p-3 text-xs leading-relaxed",
          className,
        )}
        {...rawProps}
      >
        {children}
      </pre>
    </div>
  )
}

function childrenToText(children: React.ReactNode): string {
  if (children == null) return ""
  if (typeof children === "string") return children
  if (typeof children === "number") return String(children)
  if (Array.isArray(children)) return children.map(childrenToText).join("")
  if (React.isValidElement(children)) {
    const props = children.props as { children?: React.ReactNode }
    return childrenToText(props.children)
  }
  return ""
}

function detectLang(children: React.ReactNode): string {
  if (!React.isValidElement(children)) return ""
  const props = children.props as { className?: string }
  const cn0 = props.className
  if (typeof cn0 === "string" && cn0.startsWith("language-")) {
    return cn0.slice("language-".length).split(" ")[0]
  }
  // Sometimes <pre> wraps an array of children; first is the code.
  return ""
}
