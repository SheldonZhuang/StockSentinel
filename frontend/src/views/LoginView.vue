<template>
  <div class="login-view">
    <div class="login-card">
      <h1 class="app-title">📡 {{ isRegister ? $t('auth.registerTitle') : $t('auth.loginTitle') }}</h1>

      <form @submit.prevent="submit" class="login-form">
        <div class="field">
          <label>{{ $t('auth.email') }}</label>
          <input v-model="email" type="email" required autocomplete="email" />
        </div>
        <div class="field">
          <label>{{ $t('auth.password') }}</label>
          <input v-model="password" type="password" required autocomplete="current-password" />
        </div>
        <div v-if="error" class="error">{{ error }}</div>
        <button type="submit" :disabled="loading" class="submit-btn">
          {{ loading ? '...' : (isRegister ? $t('auth.register') : $t('auth.login')) }}
        </button>
      </form>

      <button @click="isRegister = !isRegister" class="toggle-btn">
        {{ isRegister ? $t('auth.hasAccount') : $t('auth.noAccount') }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';

const router = useRouter();
const auth = useAuthStore();

const email = ref('');
const password = ref('');
const isRegister = ref(false);
const loading = ref(false);
const error = ref('');

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    if (isRegister.value) {
      await auth.register(email.value, password.value);
    } else {
      await auth.login(email.value, password.value);
    }
    router.push('/');
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-view {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 80vh;
}

.login-card {
  background: var(--panel-a);
  border: 1px solid var(--border-2);
  border-radius: 16px;
  padding: 32px;
  width: 100%;
  max-width: 380px;
}

.app-title { font-size: 20px; color: var(--text-1); margin: 0 0 24px 0; }

.login-form { display: flex; flex-direction: column; gap: 14px; margin-bottom: 16px; }

.field { display: flex; flex-direction: column; gap: 5px; }
.field label { font-size: var(--fs-md); color: var(--text-3); }
.field input {
  background: var(--bg-input);
  border: 1px solid var(--border-3);
  border-radius: 8px;
  color: var(--text-1);
  padding: 10px 12px;
  font-size: var(--fs-lg);
}
.field input:focus { outline: none; border-color: var(--border-focus); }

.error { font-size: var(--fs-md); color: var(--red); }

.submit-btn {
  background: var(--green-bg);
  color: var(--green);
  border: 1px solid var(--green-border);
  border-radius: 8px;
  padding: 10px;
  font-size: var(--fs-lg);
  font-weight: 600;
  cursor: pointer;
}
.submit-btn:disabled { opacity: 0.5; cursor: default; }

.toggle-btn {
  background: none;
  border: none;
  color: var(--blue);
  font-size: var(--fs-md);
  cursor: pointer;
  padding: 0;
}
.toggle-btn:hover { text-decoration: underline; }
</style>
