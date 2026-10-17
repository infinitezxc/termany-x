import assert from "node:assert/strict";
import test from "node:test";

import { dictionaries, LANGUAGES, matchLanguage, translate } from "./i18n/index";
import en from "./i18n/locales/en";

test("matchLanguage maps all Chinese variants to Simplified Chinese", () => {
  assert.equal(matchLanguage("zh"), "zh-CN");
  assert.equal(matchLanguage("zh-CN"), "zh-CN");
  assert.equal(matchLanguage("zh-Hans-CN"), "zh-CN");
  assert.equal(matchLanguage("zh-TW"), "zh-CN");
  assert.equal(matchLanguage("zh-HK"), "zh-CN");
  assert.equal(matchLanguage("zh-Hant"), "zh-CN");
});

test("matchLanguage falls back from a region to its base language", () => {
  assert.equal(matchLanguage("EN-gb"), "en");
});

test("matchLanguage reports unshipped languages rather than guessing", () => {
  assert.deepEqual(LANGUAGES.map(({ value }) => value), ["en", "zh-CN"]);
  assert.equal(matchLanguage("fr-CA"), null);
  assert.equal(matchLanguage("de-AT"), null);
  assert.equal(matchLanguage("pt-PT"), null);
  assert.equal(matchLanguage("fi"), null);
  assert.equal(matchLanguage("el"), null);
  assert.equal(matchLanguage(""), null);
});

// These two read the dictionaries directly rather than going through
// translate(): translate() falls back to English, so a dropped or misspelled
// key would quietly return the English string and the assertion would pass.
test("every locale covers exactly the English keys", () => {
  const expected = Object.keys(en).sort();
  for (const { value } of LANGUAGES) {
    // deepEqual catches both directions — a missing translation and a typo'd
    // key (which shows up as one missing key plus one unexpected one).
    assert.deepEqual(Object.keys(dictionaries[value]).sort(), expected, `${value} keys drifted`);
  }
});

test("translations keep every placeholder the English string declares", () => {
  const placeholders = (s: string) => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort();
  for (const { value } of LANGUAGES) {
    for (const [key, source] of Object.entries(en)) {
      const translated = dictionaries[value][key as keyof typeof en];
      assert.equal(typeof translated, "string", `${value} is missing "${key}"`);
      assert.deepEqual(
        placeholders(translated as string),
        placeholders(source),
        `${value} "${key}" changed its placeholders`
      );
    }
  }
});

test("translate fills placeholders and leaves unknown ones alone", () => {
  assert.equal(translate("en", "gitdiff.summary", { files: 3 }), "3 files");
  assert.equal(translate("zh-CN", "gitdiff.summary", { files: 3 }), "3 个文件");
  assert.equal(translate("en", "gitdiff.summary", {}), "{files} files");
});
