const BASE = '/api';

function getToken() {
  return localStorage.getItem('token');
}

async function request(path, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(BASE + path, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  // Signal
  getSignal: () => request('/signal'),
  getSignalHistory: (limit = 90) => request(`/signal/history?limit=${limit}`),

  // Auth
  register: (email, password) => request('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }),
  login: (email, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  getMe: () => request('/user/me'),

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
  getReference: (category) => request(`/admin/reference?category=${category}`),

  // AI Chain Bottleneck
  getBottleneck: () => request('/bottleneck'),
  getAiChain: () => request('/ai-chain'),
  setBottleneck: (stage, note) =>
    request('/admin/bottleneck', { method: 'POST', body: JSON.stringify({ stage, note }) }),
};
