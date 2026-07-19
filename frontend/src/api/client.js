const BASE = '/api';

function getToken() {
  return localStorage.getItem('token');
}

async function request(path, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(BASE + path, { ...options, headers });
  // 网关 502/504 等场景返回 HTML，res.json() 会抛难懂的 SyntaxError，先兜住
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status; // 让调用方能区分 401（token失效）与网络/服务端故障
    throw err;
  }
  return data;
}

export const api = {
  // Signal
  getSignal: () => request('/signal'),
  getDailyReport: () => request('/daily-report'),
  getSignalHistory: (limit = 90) => request(`/signal/history?limit=${limit}`),

  // Auth
  register: (email, password) => request('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }),
  login: (email, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  getMe: () => request('/user/me'),
  updateAlerts: (enabled) => request('/user/alerts', { method: 'PATCH', body: JSON.stringify({ enabled }) }),

  // Watchlist
  getWatchlist: (start, end) => {
    const params = [];
    if (start) params.push(`start=${start}`);
    if (end) params.push(`end=${end}`);
    return request('/watchlist' + (params.length ? '?' + params.join('&') : ''));
  },
  addToWatchlist: (symbol) => request('/watchlist', { method: 'POST', body: JSON.stringify({ symbol }) }),
  removeFromWatchlist: (symbol) => request(`/watchlist/${symbol}`, { method: 'DELETE' }),

  // Admin
  getAdminSignals: () => request('/admin/signals'),
  setAdminSignal: (type, signal, expiresAt, note) =>
    request('/admin/signals', { method: 'POST', body: JSON.stringify({ type, signal, expiresAt, note }) }),
  getAdminHistory: () => request('/admin/signal-history'),
  adminListApiKeys: () => request('/admin/api-keys'),
  adminCreateApiKey: (name, tier) =>
    request('/admin/api-keys', { method: 'POST', body: JSON.stringify({ name, tier }) }),
  adminToggleApiKey: (id, disabled) =>
    request(`/admin/api-keys/${id}`, { method: 'PATCH', body: JSON.stringify({ disabled }) }),
  getReference: (category) => request(`/admin/reference?category=${category}`),
  setLockOverride: (type, expiresAt, note) =>
    request('/admin/lock-override', { method: 'POST', body: JSON.stringify({ type, expiresAt, note }) }),
  getAdminS5: () => request('/admin/s5'),

  // AI Chain Bottleneck
  getBottleneck: () => request('/bottleneck'),
  getAiChain: () => request('/ai-chain'),
  setBottleneck: (stage, note) =>
    request('/admin/bottleneck', { method: 'POST', body: JSON.stringify({ stage, note }) }),
};
