import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from './stores/auth.js';
import { i18n } from './i18n/index.js';

const routes = [
  {
    // 首页公开只读（125号用户拍板）：信号/产业链/日报数据本就走公开接口，
    // 登录墙只挡住了搜索引擎与 AI 爬虫（SEO/GEO 收录的最大单变量）。
    // 登录态专属面板（自选股/邮件开关）由 HomeView 按登录态条件渲染
    path: '/',
    component: () => import('./views/HomeView.vue'),
    meta: { titleKey: 'pageTitle.home' },
  },
  {
    // 公开信号存档（track record）：无需登录，供任何人验证信号历史
    path: '/track-record',
    component: () => import('./views/TrackRecordView.vue'),
    meta: { titleKey: 'pageTitle.trackRecord' },
  },
  {
    path: '/login',
    component: () => import('./views/LoginView.vue'),
    meta: { titleKey: 'pageTitle.login' },
  },
  {
    path: '/admin',
    component: () => import('./views/AdminView.vue'),
    meta: { requiresAuth: true, requiresAdmin: true, titleKey: 'pageTitle.admin' },
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

// 每路由标题（125号 SEO）：按当前 i18n 语言设置 document.title
router.afterEach((to) => {
  const key = to.meta.titleKey;
  const t = i18n.global.t;
  document.title = key ? t(key) : t('pageTitle.home');
});

export default router;
