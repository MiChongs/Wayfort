// presetIconFor derives a brand icon token for a configured provider row, which
// (unlike a catalog preset) doesn't store an icon. It matches the base URL host
// against the known catalog endpoints, falling back to a per-kind default. Pure +
// dependency-free so the list/detail can render brand glyphs without extra fetch.

const HOST_ICON: { match: string; icon: string }[] = [
  { match: "deepseek.com", icon: "text:DS" },
  { match: "siliconflow", icon: "text:硅" },
  { match: "moonshot", icon: "text:Ki" },
  { match: "bigmodel", icon: "text:GLM" },
  { match: "dashscope", icon: "simple:alibabacloud" },
  { match: "aliyuncs", icon: "simple:alibabacloud" },
  { match: "volces", icon: "text:豆" },
  { match: "baidubce", icon: "text:文" },
  { match: "minimax", icon: "text:MM" },
  { match: "stepfun", icon: "text:阶" },
  { match: "lingyiwanwu", icon: "text:零" },
  { match: "openrouter", icon: "text:OR" },
  { match: "groq", icon: "text:Gq" },
  { match: "x.ai", icon: "text:xAI" },
  { match: "mistral", icon: "simple:mistralai" },
  { match: "together", icon: "text:Tg" },
  { match: "fireworks", icon: "text:Fw" },
  { match: "azure", icon: "text:Az" },
  { match: "huggingface", icon: "simple:huggingface" },
  { match: "11434", icon: "simple:ollama" }, // Ollama default port
  { match: "ollama", icon: "simple:ollama" },
  { match: ":1234", icon: "text:LM" }, // LM Studio default port
]

const KIND_ICON: Record<string, string> = {
  openai: "text:GPT",
  anthropic: "simple:anthropic",
  gemini: "simple:googlegemini",
  openai_compatible: "lucide:server",
}

export function presetIconFor(p: { kind: string; base_url?: string }): string {
  const url = (p.base_url || "").toLowerCase()
  for (const h of HOST_ICON) if (url.includes(h.match)) return h.icon
  return KIND_ICON[p.kind] ?? "lucide:sparkles"
}
