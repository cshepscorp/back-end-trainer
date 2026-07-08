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

/* ============================================================
   EMBEDDED-VIEW ADJUSTMENT
   quiz.html can open any topic page inside a modal iframe (see the
   "View in guide" source links) so looking something up mid-quiz doesn't
   lose your place. But that page's own "← back to topics" link still
   just navigates the iframe to index.html, which is a dead end inside a
   modal — there's no path back to the quiz from there. If this page
   detects it's embedded, repurpose that link into a close control for
   the modal instead of a navigation link.
   ============================================================ */
(function () {
  const isEmbedded = window.self !== window.top;
  if (!isEmbedded) return;

  document.addEventListener('DOMContentLoaded', function () {
    const backLink = document.querySelector('.back-link');
    if (!backLink) return;

    backLink.textContent = '✕ Close';
    backLink.href = '#';
    backLink.setAttribute('title', 'Close this preview and return to the quiz');
    backLink.addEventListener('click', function (e) {
      e.preventDefault();
      try {
        // Same-origin (both served from the guide's own domain), so this
        // reaches straight into quiz.html's own modal-close function.
        // Wrapped in try/catch in case this page is ever embedded
        // somewhere else entirely, where parent access would throw.
        if (window.parent && typeof window.parent.closeSourceModal === 'function') {
          window.parent.closeSourceModal();
        }
      } catch (err) {
        // Cross-origin or otherwise inaccessible parent — nothing to do.
      }
    });
  });
})();
