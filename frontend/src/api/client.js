const BASE = '/api';

function getToken() {
  return localStorage.getItem('token');
}

// 哨兵区分"响应体非JSON"与后端合法返回的 JSON null（如未设置的瓶颈环节）
const PARSE_FAIL = Symbol('parse-fail');

async function request(path, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(BASE + path, { ...options, headers });
  // 网关 502/504 等场景返回 HTML，res.json() 会抛难懂的 SyntaxError，先兜住
  const data = await res.json().catch(() => PARSE_FAIL);
  if (!res.ok) {
    const err = new Error((data !== PARSE_FAIL && data?.error) || `HTTP ${res.status}`);
    err.status = res.status; // 让调用方能区分 401（token失效）与网络/服务端故障
    throw err;
  }
  if (data === PARSE_FAIL) {
    // 200 但响应体非JSON（反代误配把SPA fallback页当API响应等）：本项目全部端点均返回JSON，
    // 这必是故障——走统一错误路径，而不是把 null 交给调用方 .length 崩掉组件子树
    const err = new Error('Invalid JSON response');
    err.status = res.status;
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
  adminCreateApiKey: (name, tier, userId = null) =>
    request('/admin/api-keys', { method: 'POST', body: JSON.stringify({ name, tier, userId }) }),
  adminToggleApiKey: (id, disabled) =>
    request(`/admin/api-keys/${id}`, { method: 'PATCH', body: JSON.stringify({ disabled }) }),
  adminBindApiKey: (id, userId) =>
    request(`/admin/api-keys/${id}`, { method: 'PATCH', body: JSON.stringify({ userId }) }),
  // 用户管理（123号）
  adminListUsers: (search = '', page = 1) =>
    request(`/admin/users?search=${encodeURIComponent(search)}&page=${page}`),
  adminUpdateUser: (id, patch) =>
    request(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  adminUserUsage: (id, { days = 30, channel = '', page = 1 } = {}) =>
    request(`/admin/users/${id}/usage?days=${days}&page=${page}` + (channel ? `&channel=${channel}` : '')),
  adminEndpointStats: (days = 30) => request(`/admin/endpoint-stats?days=${days}`),
  getReference: (category) => request(`/admin/reference?category=${category}`),
  setLockOverride: (type, expiresAt, note) =>
    request('/admin/lock-override', { method: 'POST', body: JSON.stringify({ type, expiresAt, note }) }),
  // 116号：撤销现存清锁覆盖（锁按 raw 状态恢复）
  cancelLockOverride: (type, note) =>
    request('/admin/lock-override', { method: 'POST', body: JSON.stringify({ type, cancel: true, note }) }),
  getAdminS5: () => request('/admin/s5'),

  // AI Chain Bottleneck
  getBottleneck: () => request('/bottleneck'),
  getAiChain: () => request('/ai-chain'),
  setBottleneck: (stage, note) =>
    request('/admin/bottleneck', { method: 'POST', body: JSON.stringify({ stage, note }) }),
};
