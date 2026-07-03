// Shared API helpers used by all app pages

const API = {
  async fetch(path, opts = {}) {
    const res = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...opts.headers }, ...opts });
    if (res.status === 401) { window.location.href = '/login.html'; return; }
    if (res.status === 403) {
      const data = await res.json().catch(() => ({}));
      if (data.code === 'SUBSCRIPTION_REQUIRED') { window.location.href = '/pricing.html'; return; }
    }
    return res;
  },
  async get(path)         { return this.fetch(path); },
  async post(path, body)  { return this.fetch(path, { method: 'POST',   body: JSON.stringify(body) }); },
  async put(path, body)   { return this.fetch(path, { method: 'PUT',    body: JSON.stringify(body) }); },
  async del(path)         { return this.fetch(path, { method: 'DELETE' }); },
};

async function requireAuth() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (!res.ok) { window.location.href = '/login.html'; return null; }
    const { user } = await res.json();
    return user;
  } catch { window.location.href = '/login.html'; return null; }
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  window.location.href = '/';
}
