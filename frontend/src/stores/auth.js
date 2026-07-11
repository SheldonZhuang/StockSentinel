import { ref, computed } from 'vue';
import { api } from '../api/client.js';

// 简单的 composable auth store（不依赖 Pinia）
const user = ref(null);
const checked = ref(false);
let initPromise = null;

async function init() {
  if (checked.value) return;
  // 路由守卫与 App onMounted 会并发调用，飞行中共享同一次初始化；
  // 完成后清空，之后是否重跑由 checked 决定（测试会重置 checked）
  initPromise ??= (async () => {
    const token = localStorage.getItem('token');
    if (token) {
      try {
        user.value = await api.getMe();
      } catch (e) {
        // 只有 401/403（token 确实失效）才清除；网络抖动/后端重启不应把用户登出
        if (e.status === 401 || e.status === 403) localStorage.removeItem('token');
      }
    }
    checked.value = true;
  })().finally(() => { initPromise = null; });
  return initPromise;
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
