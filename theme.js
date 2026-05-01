/* theme.js — load in every page before </body>
   Reads saved preference from localStorage, applies on load,
   and wires up any .theme-toggle button on the page. */

(function () {
  const STORAGE_KEY = 'sg-theme';
  const DARK  = 'dark';
  const LIGHT = 'light';

  // Apply theme to <html> so it's available before paint
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
    // Update all toggle buttons on the page
    document.querySelectorAll('.theme-toggle').forEach(btn => {
      btn.setAttribute('aria-label', theme === DARK ? 'Switch to light mode' : 'Switch to dark mode');
      btn.querySelector('.toggle-icon').textContent = theme === DARK ? '☀︎' : '☽';
      btn.querySelector('.toggle-label').textContent = theme === DARK ? 'Light' : 'Dark';
    });
  }

  // Read saved preference, fall back to dark
  const saved = localStorage.getItem(STORAGE_KEY) || DARK;
  applyTheme(saved);

  // Wire up toggles after DOM is ready
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.theme-toggle').forEach(btn => {
      btn.addEventListener('click', function () {
        const current = document.documentElement.getAttribute('data-theme');
        applyTheme(current === DARK ? LIGHT : DARK);
      });
    });
  });
})();
