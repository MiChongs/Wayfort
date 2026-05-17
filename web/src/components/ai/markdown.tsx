"use client"

import * as React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"

export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert prose-pre:bg-zinc-950 prose-pre:text-zinc-100 prose-code:before:hidden prose-code:after:hidden">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
