import { useCallback, useEffect, useMemo, useState } from "react";

import en from "./locales/en";
import zhCN from "./locales/zh-CN";
const STORAGE_KEY = "termany.language";
const LANGUAGE_CHANGED_EVENT = "termany:language-changed";

export type Language = "en" | "zh-CN";

/**
 * Every shipped language, in the order the Settings picker shows them. Labels
 * are the language's own endonym rather than a translated name: someone who
 * lands in the wrong language still has to find their way out of this list.
 */
export const LANGUAGES: ReadonlyArray<{ value: Language; label: string }> = [
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
];

/** English is the source locale; the rest may lag behind it and fall back. */
type TranslationKey = keyof typeof en;
type Dictionary = Partial<Record<TranslationKey, string>>;

export const dictionaries: Record<Language, Dictionary> = {
  en,
  "zh-CN": zhCN,
};

const SUPPORTED = new Set<string>(LANGUAGES.map((l) => l.value));

/** Map English and Chinese BCP-47 tags onto the two shipped locales. */
export function matchLanguage(tag: string): Language | null {
  const base = tag.trim().toLowerCase().split("-")[0];
  if (base === "zh") return "zh-CN";
  if (base === "en") return "en";
  return null;
}

function normalizeLanguage(value: string | null | undefined): Language {
  if (!value) return "en";
  if (SUPPORTED.has(value)) return value as Language;
  return matchLanguage(value) ?? "en";
}

/**
 * The language to use when nothing has been picked yet. `navigator.languages`
 * is ordered by preference, so the first entry we actually ship wins — a
 * fr-CA/en user gets English.
 */
function detectLanguage(): Language {
  try {
    const candidates = [...(navigator.languages ?? []), navigator.language].filter(Boolean);
    for (const tag of candidates) {
      const match = matchLanguage(tag);
      if (match) return match;
    }
  } catch {
    // Non-browser context (tests, SSR) — fall through to English.
  }
  return "en";
}

export function getLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? normalizeLanguage(stored) : detectLanguage();
  } catch {
    return "en";
  }
}

export function setLanguage(language: Language) {
  localStorage.setItem(STORAGE_KEY, language);
  window.dispatchEvent(new Event(LANGUAGE_CHANGED_EVENT));
}

/**
 * Look up `key`, falling back to English then to the key itself, and fill any
 * `{placeholder}` from `params`. Placeholders (rather than string concatenation
 * at the call site) let a translation reorder the sentence around its values —
 * e.g. "24 GB of 32 GB" vs "共 32 GB，已用 24 GB".
 */
export function translate(language: Language, key: string, params?: Record<string, string | number>) {
  const k = key as TranslationKey;
  const raw = dictionaries[language][k] ?? en[k] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

export function useI18n() {
  const [language, setCurrentLanguage] = useState(getLanguage);

  useEffect(() => {
    const onChange = () => setCurrentLanguage(getLanguage());
    window.addEventListener(LANGUAGE_CHANGED_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(LANGUAGE_CHANGED_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  // `t` is memoized on the language, not rebuilt per render: callers put it in
  // useMemo/useEffect dependency lists, and an unstable identity there silently
  // turns those into "runs every render" (it once reset the ⌘P palette's
  // selection on every keystroke, so the arrow keys appeared dead).
  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(language, key, params),
    [language]
  );

  return useMemo(() => ({ language, setLanguage, t }), [language, t]);
}
