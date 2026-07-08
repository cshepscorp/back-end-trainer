/* notes.js — floating "My Notes" widget, loaded on every page.
   Lets you jot down anything unclear as you go. Notes save straight to
   localStorage (same pattern as sg-theme / sg-quiz-progress) and are
   reviewable, deletable, and clearable from notes.html. */

(function () {
  const NOTES_KEY = 'sg-notes';

  function getNotes() {
    try {
      return JSON.parse(localStorage.getItem(NOTES_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function saveNotes(notes) {
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  }

  function currentPageInfo() {
    const page = (window.location.pathname.split('/').pop() || 'index.html') || 'index.html';
    const h1 = document.querySelector('h1');
    let title = document.title;
    if (h1) {
      const clone = h1.cloneNode(true);
      clone.querySelectorAll('br').forEach(br => br.replaceWith(' '));
      title = clone.textContent.replace(/\s+/g, ' ').trim();
    }
    return { page: page, title: title };
  }

  function updateBadge() {
    const badge = document.getElementById('sg-notes-count');
    if (!badge) return;
    const n = getNotes().length;
    badge.textContent = n > 0 ? String(n) : '';
    badge.style.display = n > 0 ? 'flex' : 'none';
  }

  // Don't double-inject if notes.js somehow runs twice
  if (document.getElementById('sg-notes-btn')) return;

  /* ---------- styles ---------- */
  const style = document.createElement('style');
  style.textContent = `
    #sg-notes-btn {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 52px;
      height: 52px;
      border-radius: 50%;
      background: var(--blue, #6c8ef5);
      color: #fff;
      border: none;
      font-size: 20px;
      cursor: pointer;
      box-shadow: 0 4px 18px rgba(0,0,0,0.35);
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.15s;
    }
    #sg-notes-btn:hover { transform: scale(1.06); }
    #sg-notes-count {
      position: absolute;
      top: -4px;
      right: -4px;
      background: var(--coral, #f87171);
      color: #fff;
      font-family: var(--mono, monospace);
      font-size: 10px;
      min-width: 18px;
      height: 18px;
      border-radius: 9px;
      align-items: center;
      justify-content: center;
      padding: 0 4px;
      display: none;
    }
    #sg-notes-panel {
      position: fixed;
      bottom: 88px;
      right: 24px;
      width: 300px;
      max-width: calc(100vw - 48px);
      background: var(--surface, #13161e);
      border: 1px solid var(--border, #242836);
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 10px 34px rgba(0,0,0,0.4);
      z-index: 9999;
      display: none;
      font-family: var(--sans, sans-serif);
    }
    #sg-notes-panel.open { display: block; }
    #sg-notes-panel .snp-label {
      font-family: var(--mono, monospace);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--muted, #6b7290);
      margin-bottom: 8px;
    }
    #sg-notes-panel textarea {
      width: 100%;
      min-height: 72px;
      resize: vertical;
      background: var(--surface2, #1a1e2a);
      border: 1px solid var(--border, #242836);
      border-radius: 8px;
      padding: 10px 12px;
      color: var(--ink, #eef0f8);
      font-family: var(--sans, sans-serif);
      font-size: 13.5px;
      line-height: 1.5;
      margin-bottom: 10px;
      box-sizing: border-box;
    }
    #sg-notes-panel textarea:focus { outline: none; border-color: var(--blue, #6c8ef5); }
    #sg-notes-panel .snp-actions { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    #sg-notes-panel .snp-save {
      font-family: var(--mono, monospace);
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 1px;
      padding: 7px 14px;
      border-radius: 8px;
      border: 1px solid var(--blue, #6c8ef5);
      background: var(--blue, #6c8ef5);
      color: #fff;
      cursor: pointer;
    }
    #sg-notes-panel .snp-close {
      font-family: var(--mono, monospace);
      font-size: 10px;
      color: var(--muted, #6b7290);
      background: none;
      border: none;
      cursor: pointer;
      text-decoration: underline;
    }
    #sg-notes-panel .snp-status { font-family: var(--mono, monospace); font-size: 10px; color: var(--green, #4ade80); min-height: 12px; display: block; margin-bottom: 4px; }
    #sg-notes-panel .snp-viewall {
      display: block;
      text-align: center;
      margin-top: 6px;
      padding-top: 10px;
      border-top: 1px solid var(--border, #242836);
      font-family: var(--mono, monospace);
      font-size: 9.5px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--muted, #6b7290);
      text-decoration: none;
    }
    #sg-notes-panel .snp-viewall:hover { color: var(--ink, #eef0f8); }
  `;
  document.head.appendChild(style);

  /* ---------- button ---------- */
  const btn = document.createElement('button');
  btn.id = 'sg-notes-btn';
  btn.setAttribute('aria-label', 'Add a note');
  btn.innerHTML = '&#9998;<span id="sg-notes-count"></span>';
  document.body.appendChild(btn);

  /* ---------- panel ---------- */
  const panel = document.createElement('div');
  panel.id = 'sg-notes-panel';
  panel.innerHTML =
    '<div class="snp-label">Quick note — saved automatically</div>' +
    '<textarea id="sg-notes-input" placeholder="What\'s unclear? e.g. &quot;still fuzzy on libuv&quot;..."></textarea>' +
    '<div class="snp-actions">' +
      '<button class="snp-save" id="sg-notes-save">Save note</button>' +
      '<button class="snp-close" id="sg-notes-cancel">Close</button>' +
    '</div>' +
    '<span class="snp-status" id="sg-notes-status"></span>' +
    '<a class="snp-viewall" href="notes.html">View all notes &rarr;</a>';
  document.body.appendChild(panel);

  const input = document.getElementById('sg-notes-input');
  const status = document.getElementById('sg-notes-status');

  function openPanel() {
    panel.classList.add('open');
    input.focus();
  }
  function closePanel() {
    panel.classList.remove('open');
    status.textContent = '';
  }

  btn.addEventListener('click', () => {
    if (panel.classList.contains('open')) {
      closePanel();
    } else {
      openPanel();
    }
  });

  document.getElementById('sg-notes-cancel').addEventListener('click', closePanel);

  function saveCurrentNote() {
    const text = input.value.trim();
    if (!text) return;
    const info = currentPageInfo();
    const notes = getNotes();
    notes.unshift({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      text: text,
      page: info.page,
      title: info.title,
      ts: new Date().toISOString()
    });
    saveNotes(notes);
    input.value = '';
    status.textContent = 'Saved ✓';
    updateBadge();
    setTimeout(() => { closePanel(); }, 900);
  }

  document.getElementById('sg-notes-save').addEventListener('click', saveCurrentNote);

  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      saveCurrentNote();
    }
  });

  // click outside to close
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('open')) return;
    if (panel.contains(e.target) || btn.contains(e.target)) return;
    closePanel();
  });

  updateBadge();
})();
