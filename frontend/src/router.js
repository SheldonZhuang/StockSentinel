import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from './stores/auth.js';

const routes = [
  {
    path: '/',
    component: () => import('./views/HomeView.vue'),
    meta: { requiresAuth: true },
  },
  {
    // 公开信号存档（track record）：无需登录，供任何人验证信号历史
    path: '/track-record',
    component: () => import('./views/TrackRecordView.vue'),
  },
  {
    path: '/login',
    component: () => import('./views/LoginView.vue'),
  },
  {
    path: '/admin',
    component: () => import('./views/AdminView.vue'),
    meta: { requiresAuth: true, requiresAdmin: true },
  },
  {
    // 未知路径回首页，避免只剩导航栏的空白页
    path: '/:pathMatch(.*)*',
    redirect: '/',
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.checked.value) await auth.init();

  if (to.meta.requiresAuth && !auth.user.value) return '/login';
  if (to.meta.requiresAdmin && !auth.isAdmin.value) return '/';
  if (to.path === '/login' && auth.user.value) return '/';
});

export default router;
