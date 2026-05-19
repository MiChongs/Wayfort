// i18next initialization for the web app. Imported as a side-effect from
// providers.tsx so the singleton is ready before any client component
// renders.
//
// Scope (Phase 1): only WebSSHTerminal uses translations. The rest of
// the app remains Chinese-hardcoded — that bigger migration is a
// follow-up PR. The `terminal.*` namespace defined here is the
// canonical structure future migrations should match.
//
// Choices:
//   - `useSuspense: false` — Suspense boundaries inside client
//     components are awkward in App Router; we render synchronously
//     with already-loaded resources.
//   - `load: "languageOnly"` — collapses `zh-CN`/`zh-TW` → `zh` and
//     `en-US`/`en-GB` → `en`. We don't ship Hant translations.
//   - `fallbackLng: "zh"` — SSR's first paint is Chinese; client
//     LanguageDetector switches to `en` post-hydration if the browser
//     prefers English (no `localStorage["jsa.locale"]` override).
//   - Resources inlined via `import` — avoids async/Suspense and keeps
//     the bundle small enough (the `terminal.*` namespace is tiny).

import i18n from "i18next"
import LanguageDetector from "i18next-browser-languagedetector"
import { initReactI18next } from "react-i18next"

import zh from "./locales/zh.json"
import en from "./locales/en.json"

if (!i18n.isInitialized) {
  i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources: {
        zh: { translation: zh },
        en: { translation: en },
      },
      supportedLngs: ["zh", "en"],
      fallbackLng: "zh",
      load: "languageOnly",
      detection: {
        order: ["localStorage", "navigator"],
        lookupLocalStorage: "jsa.locale",
        caches: ["localStorage"],
      },
      interpolation: {
        // React already escapes; double-escaping breaks Chinese punctuation
        // and inflates rendered output.
        escapeValue: false,
      },
      react: {
        // Required: we render inside client components without a
        // Suspense boundary above them.
        useSuspense: false,
      },
    })
}

export default i18n
