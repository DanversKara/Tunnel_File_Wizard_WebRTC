// Tunnel File Wizard — shared theme + light/dark mode for the account pages
// (setup, login, signup, account, admin). Same 5 themes as the main page.
//
// How it works: the theme/mode choice lives per-device in localStorage.
// CSS variables are applied straight to <html> the moment this script runs
// (it's included in <head>, so there's no flash of the wrong theme), the
// mode toggle + swatches are wired once the DOM is ready, and the
// admin-uploaded brand logo is swapped to match the current mode.

(function () {
  // Same themes as public/index.html — keep the two in sync.
  const THEMES = {
    amber: {
      name: 'Amber', swatch: '#e8a33d',
      dark:  { '--bg': '#12151a', '--panel': '#1a1e26', '--line': '#2a2f3a', '--text': '#e7e9ee', '--muted': '#8b93a3', '--accent': '#e8a33d', '--accent-dim': '#6b5527', '--accent-fg': '#1a1206', '--inset': '#0f1218' },
      light: { '--bg': '#faf7f2', '--panel': '#ffffff', '--line': '#e7ded0', '--text': '#241d10', '--muted': '#8a7d63', '--accent': '#c9822a', '--accent-dim': '#f0d9b3', '--accent-fg': '#ffffff', '--inset': '#f3ede1' },
    },
    midnight: {
      name: 'Midnight', swatch: '#4fb3d9',
      dark:  { '--bg': '#0b1320', '--panel': '#111b2c', '--line': '#1f2c40', '--text': '#e6edf7', '--muted': '#8394ac', '--accent': '#4fb3d9', '--accent-dim': '#2c5568', '--accent-fg': '#062430', '--inset': '#0a121e' },
      light: { '--bg': '#f3f8fb', '--panel': '#ffffff', '--line': '#d7e5ee', '--text': '#0d1b28', '--muted': '#5c7488', '--accent': '#1e8bbd', '--accent-dim': '#cbe6f2', '--accent-fg': '#ffffff', '--inset': '#e9f2f7' },
    },
    forest: {
      name: 'Forest', swatch: '#7fbf6a',
      dark:  { '--bg': '#0f1811', '--panel': '#16211a', '--line': '#28372c', '--text': '#e6ede8', '--muted': '#8a9c8f', '--accent': '#7fbf6a', '--accent-dim': '#3f5a37', '--accent-fg': '#0f2410', '--inset': '#0c140f' },
      light: { '--bg': '#f5f9f1', '--panel': '#ffffff', '--line': '#dbe8d1', '--text': '#17240f', '--muted': '#5f7952', '--accent': '#4c9536', '--accent-dim': '#d6ecc7', '--accent-fg': '#ffffff', '--inset': '#eef5e7' },
    },
    rosewood: {
      name: 'Rosewood', swatch: '#e0708a',
      dark:  { '--bg': '#1a1013', '--panel': '#241419', '--line': '#3a1f28', '--text': '#f1e6e9', '--muted': '#a5828d', '--accent': '#e0708a', '--accent-dim': '#7a3542', '--accent-fg': '#2a0a13', '--inset': '#150c0f' },
      light: { '--bg': '#fbf3f4', '--panel': '#ffffff', '--line': '#f0d8dc', '--text': '#2a1015', '--muted': '#936f79', '--accent': '#c14e6d', '--accent-dim': '#f6dbe1', '--accent-fg': '#ffffff', '--inset': '#f7e6e8' },
    },
    mono: {
      name: 'Mono', swatch: '#e9eaec',
      dark:  { '--bg': '#14161a', '--panel': '#1c1f24', '--line': '#2d3138', '--text': '#e9eaec', '--muted': '#8d929c', '--accent': '#e9eaec', '--accent-dim': '#5a5d63', '--accent-fg': '#14161a', '--inset': '#101216' },
      light: { '--bg': '#f7f7f8', '--panel': '#ffffff', '--line': '#dcdde0', '--text': '#16171a', '--muted': '#6b6f78', '--accent': '#2c2f36', '--accent-dim': '#dfe0e3', '--accent-fg': '#ffffff', '--inset': '#f0f0f2' },
    },
  };

  const MODE_KEY = 'tunnel-file-wizard-mode';
  const THEME_KEY = 'tunnel-file-wizard-theme';

  function savedMode() {
    try {
      const s = localStorage.getItem(MODE_KEY);
      if (s === 'light' || s === 'dark') return s;
    } catch {}
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }

  function savedTheme() {
    try {
      const t = localStorage.getItem(THEME_KEY);
      // hasOwnProperty, not truthiness: THEMES['__proto__'] is truthy
      // (Object.prototype) but is not a real theme.
      if (t && Object.prototype.hasOwnProperty.call(THEMES, t)) return t;
    } catch {}
    return 'amber';
  }

  let mode = savedMode();
  let theme = savedTheme();

  function applyVars() {
    const vars = (THEMES[theme] && THEMES[theme][mode]) || THEMES.amber.dark;
    const root = document.documentElement;
    for (const [prop, value] of Object.entries(vars)) root.style.setProperty(prop, value);
    root.classList.toggle('mode-light', mode === 'light');
    root.classList.toggle('mode-dark', mode === 'dark');
  }

  // The admin can upload two logos (dark-mode + light-mode). Show the one
  // matching the current mode; if none exists the <img> hides itself and
  // the default brand mark shows instead.
  function refreshLogo() {
    const img = document.getElementById('brand-logo');
    if (!img) return;
    // Only reveal once the image actually loads; a 404 keeps it hidden and
    // the default brand mark shows instead. (No flash of a broken image.)
    img.onload = () => { img.classList.add('on'); };
    img.onerror = () => { img.classList.remove('on'); };
    img.src = '/branding/logo-' + mode;
  }

  function setMode(next, save) {
    mode = next === 'light' ? 'light' : 'dark';
    if (save !== false) { try { localStorage.setItem(MODE_KEY, mode); } catch {} }
    applyVars();
    refreshLogo();
    const icon = document.getElementById('mode-icon');
    if (icon) icon.textContent = mode === 'light' ? '☀️' : '🌙';
  }

  function setTheme(key, save) {
    if (!Object.prototype.hasOwnProperty.call(THEMES, key)) return;
    theme = key;
    if (save !== false) { try { localStorage.setItem(THEME_KEY, key); } catch {} }
    applyVars();
    document.querySelectorAll('#theme-row .swatch').forEach((el) => {
      el.classList.toggle('active', el.dataset.theme === key);
    });
  }

  function buildSwatches() {
    const row = document.getElementById('theme-row');
    if (!row) return;
    row.innerHTML = '';
    Object.entries(THEMES).forEach(([key, t]) => {
      const el = document.createElement('div');
      el.className = 'swatch' + (key === theme ? ' active' : '');
      el.dataset.theme = key;
      el.style.background = t.swatch;
      el.title = t.name;
      el.addEventListener('click', () => setTheme(key));
      row.appendChild(el);
    });
  }

  // Header branding options (admin panel > Branding): the default icon and
  // the site-name text can each be hidden, e.g. for a logo-only header.
  async function applyBranding() {
    let b = null;
    try {
      b = await (await fetch('/api/bootstrap')).json();
    } catch { /* ignore */ }
    if (!b) return;
    // Footer version stamp: proves at a glance whether an upgrade took effect.
    if (b.version) {
      document.querySelectorAll('.app-version').forEach((el) => { el.textContent = 'v' + b.version; });
    }
    const branding = b.branding || null;
    // The admin can rename the site (admin panel > Branding): apply it to the
    // header on every page and to the tab title. Without this the header keeps
    // showing the hardcoded default name.
    if (b.siteName) {
      document.querySelectorAll('.brand-text').forEach((el) => {
        el.textContent = b.siteName;
      });
      if (document.title.includes('Tunnel File Wizard')) {
        document.title = document.title.replace(/Tunnel File Wizard/g, b.siteName);
      }
    }
    if (!branding) return;
    const showIcon = branding.showIcon !== false;
    const showText = branding.showText !== false;
    document.querySelectorAll('.brand-icon, .brand .dot').forEach((el) => {
      el.style.display = showIcon ? '' : 'none';
    });
    document.querySelectorAll('.brand-text').forEach((el) => {
      el.style.display = showText ? '' : 'none';
    });
  }

  // Apply immediately (this script runs synchronously in <head>): the page
  // never flashes the wrong theme.
  applyVars();

  document.addEventListener('DOMContentLoaded', () => {
    const icon = document.getElementById('mode-icon');
    if (icon) icon.textContent = mode === 'light' ? '☀️' : '🌙';
    const toggle = document.getElementById('mode-toggle');
    if (toggle) toggle.addEventListener('click', () => setMode(mode === 'light' ? 'dark' : 'light'));
    buildSwatches();
    refreshLogo();
    applyBranding();
  });

  window.TFWTheme = { setMode, setTheme, getMode: () => mode, getTheme: () => theme, THEMES, refreshLogo, applyBranding };
})();
