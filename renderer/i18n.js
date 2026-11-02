import en from './locales/en.js';
import de from './locales/de.js';

const dictionaries = { en, de };
let lang = 'en';

export function setLang(value) {
  lang = dictionaries[value] ? value : 'en';
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}
export const getLang = () => lang;
export const locale = () => (lang === 'de' ? 'de-DE' : 'en-GB');

// t('key', { name: 'x' }) replaces {name} in the translated string.
export function t(key, params) {
  let s = dictionaries[lang][key] ?? dictionaries.en[key] ?? key;
  if (params) for (const k of Object.keys(params)) s = s.split(`{${k}}`).join(String(params[k]));
  return s;
}

// tp('list.count', 3) uses 'list.count_one' / 'list.count_other' via Intl.PluralRules.
export function tp(key, n, params = {}) {
  const form = new Intl.PluralRules(locale()).select(n) === 'one' ? 'one' : 'other';
  return t(`${key}_${form}`, { n, ...params });
}

export const allLocales = dictionaries;
