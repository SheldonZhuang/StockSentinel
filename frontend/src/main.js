import { createApp } from 'vue';
import App from './App.vue';
import router from './router.js';
import { i18n } from './i18n/index.js';
import './styles/theme.css';

// mount 前应用主题，避免亮色用户看到深色闪烁
document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark';

createApp(App)
  .use(router)
  .use(i18n)
  .mount('#app');
