<template>
  <div id="app">
    <!-- 导航栏 -->
    <nav class="navbar">
      <router-link to="/" class="nav-brand">
        📡
        <span class="brand-text">
          {{ $t('app.title') }}
          <span class="brand-sub">STOCK SENTINEL</span>
        </span>
      </router-link>
      <div class="nav-right">
        <!-- 主题切换 -->
        <button class="nav-btn" :title="$t('app.theme')" @click="toggleTheme">
          {{ theme === 'dark' ? '🌙' : '☀️' }}
        </button>
        <!-- 语言切换 -->
        <select class="lang-select" :value="locale" @change="onLangChange">
          <option v-for="l in langs" :key="l.code" :value="l.code">{{ l.label }}</option>
        </select>

        <template v-if="auth.user.value">
          <button
            class="nav-btn"
            :title="$t('settings.emailAlerts') + ' — ' + $t('settings.emailAlertsDesc')"
            @click="toggleAlerts"
          >
            {{ auth.user.value.emailAlerts ? '🔔' : '🔕' }}
          </button>
          <router-link v-if="auth.isAdmin.value" to="/admin" class="nav-link">
            {{ $t('admin.title') }}
          </router-link>
          <button @click="logout" class="nav-btn">{{ $t('auth.logout') }}</button>
        </template>
        <router-link v-else to="/login" class="nav-link">{{ $t('auth.login') }}</router-link>
      </div>
    </nav>

    <!-- 主内容 -->
    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import { setLocale } from './i18n/index.js';
import { api } from './api/client.js';
import { ref, onMounted } from 'vue';

const { locale } = useI18n();
const router = useRouter();
const auth = useAuthStore();

const langs = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
];

const theme = ref(document.documentElement.dataset.theme || 'dark');

function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme.value;
  localStorage.setItem('theme', theme.value);
}

function onLangChange(e) {
  setLocale(e.target.value);
}

async function toggleAlerts() {
  const next = !auth.user.value.emailAlerts;
  try {
    await api.updateAlerts(next);
    auth.user.value = { ...auth.user.value, emailAlerts: next };
  } catch (e) {
    console.error('Failed to toggle alerts', e);
  }
}

async function logout() {
  auth.logout();
  router.push('/login');
}

onMounted(() => auth.init());
</script>

<style>
.navbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 24px;
  background: var(--bg-navbar);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border-1);
  position: sticky;
  top: 0;
  z-index: 100;
}

.nav-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-1);
  font-size: 16px;
  font-weight: 700;
  text-decoration: none;
}
.brand-text { display: flex; flex-direction: column; line-height: 1.15; }
.brand-sub {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.28em;
  color: var(--brand-sub);
}

.nav-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.lang-select {
  background: var(--bg-input);
  border: 1px solid var(--border-3);
  border-radius: 6px;
  color: var(--text-3);
  padding: 5px 8px;
  font-size: 13px;
  cursor: pointer;
}

.nav-link {
  font-size: 13px;
  color: var(--text-3);
  transition: color 0.2s;
}
.nav-link:hover { color: var(--text-1); }

.nav-btn {
  background: none;
  border: 1px solid var(--border-3);
  border-radius: 6px;
  color: var(--text-3);
  padding: 5px 12px;
  font-size: 13px;
  cursor: pointer;
}
.nav-btn:hover { border-color: var(--border-focus); color: var(--text-1); }

.main-content {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px 20px;
}

@media (max-width: 600px) {
  .main-content { padding: 16px 12px; }
}
</style>
