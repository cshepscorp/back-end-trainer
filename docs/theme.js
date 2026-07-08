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
   Any page in this guide can be opened inside a modal iframe — by
   quiz.html's own "View in guide" links (same origin, github.io), and
   now also by the separate daily-quiz-app ("Preview" links, a different
   origin entirely — main.<id>.amplifyapp.com). That page's own
   "← back to topics" link still just navigates the iframe to
   index.html, which is a dead end inside a modal. If this page detects
   it's embedded, repurpose that link into a close control instead.

   Uses postMessage rather than reaching into window.parent directly —
   a direct call (window.parent.closeSourceModal()) only works when
   embedder and embedded page share an origin. postMessage works
   identically same-origin or cross-origin, so one mechanism covers
   both quiz.html and daily-quiz-app without the embedded page needing
   to know or care which one is hosting it. targetOrigin is '*' since
   the message carries no sensitive data — just a "close me" signal.
   ============================================================ */
(function () {
  const isEmbedded = window.self !== window.top;
  if (!isEmbedded) return;

  document.addEventListener('DOMContentLoaded', function () {
    const backLink = document.querySelector('.back-link');
    if (!backLink) return;

    backLink.textContent = '✕ Close';
    backLink.href = '#';
    backLink.setAttribute('title', 'Close this preview');
    backLink.addEventListener('click', function (e) {
      e.preventDefault();
      try {
        window.parent.postMessage({ type: 'close-source-preview' }, '*');
      } catch (err) {
        // Nothing reasonable to do if even postMessage fails here.
      }
    });
  });
})();
