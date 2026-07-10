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
        <!-- 语言切换 -->
        <select class="lang-select" :value="locale" @change="onLangChange">
          <option v-for="l in langs" :key="l.code" :value="l.code">{{ l.label }}</option>
        </select>

        <template v-if="auth.user.value">
          <button
            class="nav-btn alert-toggle"
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
import { onMounted } from 'vue';

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
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background:
    linear-gradient(rgba(107, 158, 255, 0.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(107, 158, 255, 0.025) 1px, transparent 1px),
    radial-gradient(ellipse 100% 60% at 50% -10%, #10141f 0%, #0a0a0a 60%);
  background-size: 44px 44px, 44px 44px, 100% 100%;
  background-attachment: fixed;
  color: #e0e0e0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-variant-numeric: tabular-nums;
  min-height: 100vh;
}

a { text-decoration: none; }

.navbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 24px;
  background: rgba(13, 13, 13, 0.75);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid #1a1a1a;
  position: sticky;
  top: 0;
  z-index: 100;
}

.nav-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #eee;
  font-size: 16px;
  font-weight: 700;
  text-decoration: none;
}
.brand-text { display: flex; flex-direction: column; line-height: 1.15; }
.brand-sub {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.28em;
  color: #4a6fa5;
}

.nav-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.lang-select {
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 6px;
  color: #aaa;
  padding: 5px 8px;
  font-size: 13px;
  cursor: pointer;
}

.nav-link {
  font-size: 13px;
  color: #888;
  transition: color 0.2s;
}
.nav-link:hover { color: #eee; }

.nav-btn {
  background: none;
  border: 1px solid #333;
  border-radius: 6px;
  color: #888;
  padding: 5px 12px;
  font-size: 13px;
  cursor: pointer;
}
.nav-btn:hover { border-color: #555; color: #eee; }

.main-content {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px 20px;
}

@media (max-width: 600px) {
  .main-content { padding: 16px 12px; }
}
</style>
