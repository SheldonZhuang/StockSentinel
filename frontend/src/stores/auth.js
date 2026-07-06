import { ref, computed } from 'vue';
import { api } from '../api/client.js';

// 简单的 composable auth store（不依赖 Pinia）
const user = ref(null);
const checked = ref(false);

async function init() {
  if (checked.value) return;
  const token = localStorage.getItem('token');
  if (token) {
    try {
      user.value = await api.getMe();
    } catch {
      localStorage.removeItem('token');
    }
  }
  checked.value = true;
}

async function login(email, password) {
  const res = await api.login(email, password);
  localStorage.setItem('token', res.token);
  user.value = await api.getMe();
}

async function register(email, password) {
  const res = await api.register(email, password);
  localStorage.setItem('token', res.token);
  user.value = await api.getMe();
}

function logout() {
  localStorage.removeItem('token');
  user.value = null;
}

const isAdmin = computed(() => user.value?.isAdmin === true);

export function useAuthStore() {
  return { user, checked, isAdmin, init, login, register, logout };
}
