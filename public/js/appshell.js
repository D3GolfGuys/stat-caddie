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

  // Owner-only: inject an Admin link into the sidebar on every page.
  if (user.isAdmin) {
    const sidebar = document.getElementById('sidebar');
    if (sidebar && !document.getElementById('admin-nav-link')) {
      const section = document.createElement('div');
      section.className = 'sidebar-section';
      section.innerHTML =
        '<div class="sidebar-label">Admin</div>' +
        '<a href="/app/admin.html" id="admin-nav-link" class="sidebar-link">' +
        '<span class="icon">📈</span> Platform Stats</a>';
      sidebar.appendChild(section);
      if (window.location.pathname === '/app/admin.html') {
        section.querySelector('.sidebar-link').classList.add('active');
      }
    }
  }

  return user;
}
