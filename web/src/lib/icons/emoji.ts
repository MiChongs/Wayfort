// Curated emoji set, grouped for the IconPicker. Token value == the emoji glyph
// (e.g. "emoji:🐳"). Kept human and ops-flavoured rather than exhaustive.

export interface EmojiGroup {
  name: string
  emojis: string[]
}

export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    name: "常用",
    emojis: ["🏷️", "⭐", "🔥", "⚡", "🚀", "💡", "🌟", "✨", "🎯", "📌", "📍", "🔖"],
  },
  {
    name: "状态",
    emojis: ["🟢", "🟡", "🔴", "🔵", "🟣", "⚪", "⚫", "✅", "❗", "⛔", "⚠️", "🆕"],
  },
  {
    name: "基建",
    emojis: ["🖥️", "💻", "🗄️", "💾", "🧱", "📦", "🐳", "☁️", "🌐", "🔌", "🛰️", "📡"],
  },
  {
    name: "安全",
    emojis: ["🛡️", "🔒", "🔓", "🔑", "🗝️", "🚨", "👁️", "🧬", "🪪", "🔐"],
  },
  {
    name: "工具",
    emojis: ["⚙️", "🔧", "🧰", "🔨", "🪛", "🧪", "🧯", "🪝", "📊", "📈", "🧮", "🗜️"],
  },
  {
    name: "环境",
    emojis: ["🏠", "🏢", "🏭", "🏬", "🌍", "🌏", "🗺️", "🧭", "🌱", "🌲", "🍃", "❄️"],
  },
  {
    name: "团队",
    emojis: ["👤", "👥", "🧑‍💻", "👮", "🦾", "🤖", "🐧", "🐙", "🦊", "🐳", "🦉", "🐝"],
  },
]

export const ALL_EMOJI = EMOJI_GROUPS.flatMap((g) => g.emojis)
