import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createRouter, createMemoryHistory } from 'vue-router';

vi.mock('../src/api/client.js', () => ({
  api: { getMe: vi.fn() },
}));

import { api } from '../src/api/client.js';
import { useAuthStore } from '../src/stores/auth.js';

async function buildRouter() {
  const routerModule = await import('../src/router.js?t=' + Math.random());
  return routerModule.default;
}

describe('router auth guard', () => {
  beforeEach(() => {
    localStorage.clear();
    const auth = useAuthStore();
    auth.user.value = null;
    auth.checked.value = false;
    vi.clearAllMocks();
  });

  it('redirects unauthenticated user from / to /login', async () => {
    const router = await buildRouter();
    router.push('/');
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/login');
  });

  it('redirects unauthenticated user from /admin to /login', async () => {
    const router = await buildRouter();
    router.push('/admin');
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/login');
  });

  it('redirects non-admin user from /admin to /', async () => {
    localStorage.setItem('token', 'fake-token');
    api.getMe.mockResolvedValue({ id: 1, email: 'user@example.com', isAdmin: false });

    const router = await buildRouter();
    router.push('/admin');
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('allows admin user to reach /admin', async () => {
    localStorage.setItem('token', 'fake-token');
    api.getMe.mockResolvedValue({ id: 1, email: 'admin@example.com', isAdmin: true });

    const router = await buildRouter();
    router.push('/admin');
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/admin');
  });

  it('redirects logged-in user away from /login to /', async () => {
    localStorage.setItem('token', 'fake-token');
    api.getMe.mockResolvedValue({ id: 1, email: 'user@example.com', isAdmin: false });

    const router = await buildRouter();
    router.push('/login');
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/');
  });
});
