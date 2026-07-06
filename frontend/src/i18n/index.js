import { createI18n } from 'vue-i18n';
import zh from './locales/zh.json';
import en from './locales/en.json';
import fr from './locales/fr.json';
import de from './locales/de.json';
import es from './locales/es.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';

function detectLocale() {
  const saved = localStorage.getItem('locale');
  if (saved) return saved;
  const lang = navigator.language?.toLowerCase() || 'en';
  if (lang.startsWith('zh')) return 'zh';
  if (lang.startsWith('fr')) return 'fr';
  if (lang.startsWith('de')) return 'de';
  if (lang.startsWith('es')) return 'es';
  if (lang.startsWith('ja')) return 'ja';
  if (lang.startsWith('ko')) return 'ko';
  return 'en';
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: 'en',
  messages: { zh, en, fr, de, es, ja, ko },
});

export function setLocale(lang) {
  i18n.global.locale.value = lang;
  localStorage.setItem('locale', lang);
}
