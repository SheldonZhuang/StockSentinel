import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from './stores/auth.js';

const routes = [
  {
    path: '/',
    component: () => import('./views/HomeView.vue'),
    meta: { requiresAuth: true },
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
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.checked) await auth.init();

  if (to.meta.requiresAuth && !auth.user) return '/login';
  if (to.meta.requiresAdmin && !auth.isAdmin) return '/';
  if (to.path === '/login' && auth.user) return '/';
});

export default router;
