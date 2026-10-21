import axios from 'axios';

const api = axios.create({
  baseURL: process.env.REACT_APP_API_URL || '/api',
  headers: { 'Content-Type': 'application/json' },
});

// POSTs that only compute and return data — a System Viewer may call
// these. Mirrors READ_ONLY_POSTS in backend/src/middleware/auth.js.
const VIEWER_ALLOWED_POSTS = ['/procurement/production-planning/plan', '/auth/login'];

const currentRole = () => {
  try { return JSON.parse(localStorage.getItem('user') || 'null')?.role; } catch { return null; }
};

// Attach JWT automatically
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // System Viewer is read-only: stop writes here with the same error shape
  // the API returns, so every page's existing `e.response?.data?.error`
  // handling shows a clear message. The server enforces this too.
  const method = (config.method || 'get').toLowerCase();
  if (method !== 'get' && method !== 'head' && currentRole() === 'Viewer'
      && !(method === 'post' && VIEWER_ALLOWED_POSTS.includes((config.url || '').split('?')[0]))) {
    const err = new Error('Read-only access');
    err.config = config;
    err.response = { status: 403, data: { error: 'Read-only access — System Viewer accounts cannot make changes' } };
    return Promise.reject(err);
  }
  return config;
});

// Redirect to login on 401
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response && err.response.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;
