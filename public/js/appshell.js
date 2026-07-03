// Renders the shared app nav + sidebar, handles auth redirect
async function initApp(opts = {}) {
  const user = await requireAuth();
  if (!user) return null;

  // Warn if subscription inactive (but don't block — server handles enforcement)
  if (user.subscription_status !== 'active' && user.role !== 'team_member') {
    const banner = document.getElementById('sub-banner');
    if (banner) banner.style.display = 'flex';
  }

  // Populate nav user name
  const nameEl = document.getElementById('nav-user-name');
  if (nameEl) nameEl.textContent = user.name;

  // Mark active sidebar link
  const currentPath = window.location.pathname;
  document.querySelectorAll('.sidebar-link').forEach(link => {
    if (link.getAttribute('href') === currentPath) link.classList.add('active');
  });

  // Show team links only for team users
  if (user.role === 'team_admin') {
    document.querySelectorAll('.team-admin-only').forEach(el => el.style.display = '');
  }

  return user;
}
