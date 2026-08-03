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

  // Coaches are team-first: reveal team sections, and hide player-only tools
  // (capture / stats reports) since coaches don't log their own rounds.
  if (user.role === 'team_admin') {
    document.querySelectorAll('.team-admin-only').forEach(el => el.style.display = '');
    document.querySelectorAll('.player-only').forEach(el => el.style.display = 'none');
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

// Mobile navigation: inject a hamburger toggle + overlay so the sidebar is
// reachable on phones (on <=768px the sidebar is an off-canvas drawer).
// Runs on every page that loads this script, independent of auth/initApp.
(function () {
  function setupMobileNav() {
    var nav = document.getElementById('app-nav');
    var sidebar = document.getElementById('sidebar');
    if (!nav || !sidebar || document.getElementById('nav-hamburger')) return;

    var btn = document.createElement('button');
    btn.id = 'nav-hamburger';
    btn.className = 'nav-hamburger';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Menu');
    btn.innerHTML = '☰'; // ☰
    nav.insertBefore(btn, nav.firstChild);

    var overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    document.body.appendChild(overlay);

    function close() {
      sidebar.classList.remove('open');
      overlay.classList.remove('show');
    }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = sidebar.classList.toggle('open');
      overlay.classList.toggle('show', open);
    });
    overlay.addEventListener('click', close);
    // Close the drawer after tapping any nav link (event delegation covers
    // links injected later, e.g. the owner-only Admin link).
    sidebar.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.sidebar-link')) close();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupMobileNav);
  } else {
    setupMobileNav();
  }
})();
