/* ===========================================================================
   server/public/shell/shell.js — the Lantern app: courses, the course
   overview, the player, what's new, settings and the owner's dashboard.
   ---------------------------------------------------------------------------
   Plain JavaScript, no build step. Routes are in the hash (#/course/cfml) so
   the server only ever serves this one page.

   The player hosts a course pack in an iframe from the same address. The
   pack keeps its own state in browser storage; this page mirrors every
   change of the pack's declared keys to the app's database (and so to the
   hub), and writes the database's copy back before the pack loads. Nothing
   about that needs the network.

   window.LanternShell is the seam for features that come later:
     registerSettings({ id, title, order, render(container) })   a Settings section
     registerAssistant(render(panel))                            the docked assistant
     registerMedia(render(slot))                                 a mini player
     context()                                                   the current learning context
     on(type, fn)                                                app events (the SSE stream)
   =========================================================================== */
(function () {
  'use strict';

  /* --------------------------------------------------------------- tools */
  const $ = (s, r) => (r || document).querySelector(s);
  function el(tag, attrs, kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'onclick' && typeof v === 'function' && tag === 'button') n.addEventListener('click', busyWhile(n, v));
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(kids || [])) if (c !== null && c !== undefined && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
  }
  /* A button that starts something slow (a request) cannot be pressed again
     until it is done: no double-sent offers, requests or sign-ups. */
  function busyWhile(btn, fn) {
    return function (e) {
      if (btn.dataset.busy) { e.preventDefault(); return; }
      const out = fn.call(this, e);
      if (out && typeof out.then === 'function') {
        btn.dataset.busy = '1'; const was = btn.disabled; btn.disabled = true; btn.setAttribute('aria-busy', 'true');
        out.catch(() => {}).then(() => { delete btn.dataset.busy; btn.removeAttribute('aria-busy'); if (!was) btn.disabled = false; });
      }
      return out;
    };
  }

  /* In-page questions (a browser's own confirm() and prompt() do nothing in
     some windows, and block everything else in the rest). */
  function ask(text, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      const input = o.input ? el(o.multiline ? 'textarea' : 'input', { type: 'text', placeholder: o.placeholder || '', maxlength: String(o.maxlength || 500), 'aria-label': o.label || text, 'data-testid': 'ask-input' }) : null;
      let answered = false;
      const done = (v) => { if (answered) return; answered = true; resolve(v); d.close(); };
      const yes = el('button', { class: 'btn ' + (o.danger ? 'danger' : 'primary'), type: 'button', 'data-testid': 'ask-yes' }, o.yes || (input ? 'OK' : 'Yes'));
      yes.addEventListener('click', () => done(input ? input.value : true));
      const no = el('button', { class: 'btn', type: 'button', 'data-testid': 'ask-no' }, o.no || 'Cancel');
      no.addEventListener('click', () => done(input ? null : false));
      const d = el('dialog', { class: 'ask', 'aria-label': o.title || text }, [o.title ? el('h2', { text: o.title }) : null, el('p', { text }), input, el('div', { class: 'row', style: 'margin-top:12px' }, [yes, no])]);
      d.addEventListener('cancel', () => done(input ? null : false));
      d.addEventListener('close', () => { done(input ? null : false); d.remove(); });
      document.body.appendChild(d); d.showModal();
      (input || yes).focus();
      if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !o.multiline) { e.preventDefault(); done(input.value); } });
    });
  }

  async function api(path, opts) {
    const o = opts || {};
    const init = { method: o.method || 'GET', headers: {} };
    if (o.body !== undefined) {
      if (o.raw) { init.body = o.body; init.headers['content-type'] = 'application/json'; }
      else { init.body = JSON.stringify(o.body); init.headers['content-type'] = 'application/json'; }
    }
    if (o.keepalive) init.keepalive = true;
    let r;
    try { r = await fetch(path, init); }
    catch (e) { throw Object.assign(new Error('Lantern is not answering just now (it may be restarting). Try again in a moment.'), { status: 0, offline: true }); }
    const text = await r.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch (e) { j = { error: text }; }
    if (!r.ok) throw Object.assign(new Error((j && j.error) || ('Something went wrong (' + r.status + ').')), { status: r.status, body: j });
    return j;
  }
  const measure = (o) => (o.finished || 0) + ' of ' + (o.count || 0) + ' steps' + (o.lessons ? ' · ' + o.lessons.done + ' of ' + o.lessons.total + ' lessons' : '');
  const fmtMin = (m) => { m = Math.round(m || 0); if (m < 60) return m + ' min'; const h = Math.floor(m / 60), r = m % 60; return h + ' h' + (r ? ' ' + r + ' min' : ''); };
  const fmtWhen = (s) => { if (!s) return ''; const d = new Date(typeof s === 'number' ? s : String(s).replace(' ', 'T') + (/Z|\+/.test(String(s)) ? '' : 'Z')); return isNaN(d) ? String(s) : d.toLocaleString(); };
  const ago = (s) => { if (!s) return 'never'; const t = Date.parse(s); if (isNaN(t)) return ''; const m = Math.round((Date.now() - t) / 60000); if (m < 2) return 'just now'; if (m < 60) return m + ' min ago'; const h = Math.round(m / 60); if (h < 48) return h + ' h ago'; return Math.round(h / 24) + ' days ago'; };
  function md(text) {
    // A small, safe subset: headings, bullets, paragraphs. Everything is text.
    const box = el('div', { class: 'md' });
    let list = null;
    String(text || '').split(/\r?\n/).forEach((line) => {
      const t = line.trim();
      if (!t) { list = null; return; }
      const h = /^(#{1,3})\s+(.*)$/.exec(t);
      if (h) { list = null; box.appendChild(el('h' + Math.min(4, h[1].length + 2), { text: h[2] })); return; }
      const b = /^[-*]\s+(.*)$/.exec(t);
      if (b) { if (!list) { list = el('ul'); box.appendChild(list); } list.appendChild(el('li', { text: b[1] })); return; }
      list = null; box.appendChild(el('p', { text: t }));
    });
    return box;
  }

  /* --------------------------------------------------------------- state */
  const S = { platform: null, courses: [], offers: [], eco: null, playing: null, listeners: {} };
  const settingsSections = [];
  const pages = {};
  function on(type, fn) { (S.listeners[type] = S.listeners[type] || []).push(fn); }
  function fire(type, ev) { (S.listeners[type] || []).forEach((f) => { try { f(ev); } catch (e) { console.error(e); } }); }

  /* --------------------------------------------------------------- theme */
  // '' follows the computer's light/dark setting; 'evening' and 'day' pin one.
  // High contrast and less motion are separate switches (data-contrast, data-motion).
  const store = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* storage blocked */ } };
  const stored = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const systemLight = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function applyPalette() {
    const H = document.documentElement;
    const p = stored('lantern.shell.theme');
    const day = p === 'day' || (!p && systemLight && systemLight.matches);
    if (day) H.setAttribute('data-theme', 'day'); else H.removeAttribute('data-theme');
    if (stored('lantern.shell.contrast') === 'high') H.setAttribute('data-contrast', 'high'); else H.removeAttribute('data-contrast');
    const m = stored('lantern.shell.motion');
    if (m) H.setAttribute('data-motion', m); else H.removeAttribute('data-motion');
  }
  applyPalette();
  if (systemLight && systemLight.addEventListener) systemLight.addEventListener('change', applyPalette);

  /* -------------------------------------------------------------- toasts */
  function toast(content, opts) {
    const o = opts || {};
    const t = el('div', { class: 'toast', 'data-testid': o.testid || null }, [
      el('button', { class: 'x', 'aria-label': 'Dismiss', onclick: () => t.remove() }, '×'),
      typeof content === 'string' ? el('div', { text: content }) : content,
    ]);
    if (o.sticky) t.dataset.sticky = '1';
    if (o.key) { document.querySelectorAll('#toasts .toast').forEach((x) => { if (x.dataset.key === o.key) x.remove(); }); t.dataset.key = o.key; }
    $('#toasts').appendChild(t);
    const all = [...document.querySelectorAll('#toasts .toast')];
    if (all.length > 4) (all.find((x) => !x.dataset.sticky && x !== t) || all[0]).remove();
    if (!o.sticky) setTimeout(() => t.remove(), o.ms || 8000);
    return t;
  }

  /* -------------------------------------------------------------- events */
  let es = null;
  function connectEvents() {
    es = new EventSource('/api/events');
    const types = ['prefs', 'offer', 'offer-answered', 'courses', 'download', 'course-updated', 'progress', 'sync', 'update', 'open', 'suggest-open', 'reminder', 'milestone', 'signed-in', 'signed-out', 'eco-in', 'mic', 'assistant-prefs', 'friends', 'friend-request', 'friend-accepted'];
    types.forEach((t) => es.addEventListener(t, (m) => { let ev = {}; try { ev = JSON.parse(m.data); } catch (e) { /* bad */ } handleEvent(ev); fire(t, ev); }));
    es.onerror = () => { setSync(false, 'Reconnecting to Lantern…'); if (!watching) { watching = true; setTimeout(checkRestart, 1500); } };
    es.onopen = () => { if (S.platform) refreshPlatform(); };
  }
  let watching = false;
  async function checkRestart() {
    try {
      const p = await api('/api/platform');
      watching = false;
      if (S.platform && p.version !== S.platform.version) {
        toast(el('div', {}, ['Lantern was updated to ' + p.version + '. ', el('a', { href: '#/whats-new', text: 'What’s new' })]), { sticky: true });
        if (!S.playing) setTimeout(() => location.reload(), 1500);
      }
      S.platform = p; paintChrome();
    } catch (e) { setTimeout(checkRestart, 2000); }
  }

  function handleEvent(ev) {
    switch (ev.type) {
      case 'offer':
        if (ev.offer) {
          const o = ev.offer;
          const box = el('div', {}, [
            el('b', { text: o.from_name + ' sent you ' + o.course_title }),
            o.message ? el('blockquote', { text: o.message }) : null,
            el('div', { class: 'row', style: 'margin-top:8px' }, [
              el('button', { class: 'btn primary', 'data-testid': 'toast-accept', onclick: () => answer(o.id, true) }, 'Accept'),
              el('button', { class: 'btn', onclick: () => answer(o.id, false) }, 'Decline'),
            ]),
          ]);
          toast(box, { sticky: true, testid: 'offer-toast' });
          if (window.Notification && Notification.permission === 'granted' && document.hidden) new Notification('Lantern', { body: o.from_name + ' sent you ' + o.course_title });
        }
        loadCourses().then(rerenderIf('home'));
        break;
      case 'courses': case 'offer-answered':
        loadCourses().then(rerenderIf('home'));
        break;
      case 'download': paintDownload(ev); if (ev.phase === 'done' || ev.phase === 'failed') loadCourses().then(rerenderIf('home')); break;
      case 'course-updated':
        if (ev.from) toast(el('div', {}, [el('b', { text: ev.title + ' was updated to ' + ev.to + '. ' }), 'Your progress is kept. ', el('a', { href: '#/whats-new', text: 'What’s new' })]), { ms: 12000 });
        loadCourses().then(rerenderIf('home'));
        break;
      case 'progress': if (route().name === 'course' && route().id === ev.course && ev.reason !== 'local') render(); break;
      case 'sync': refreshPlatform(); break;
      case 'signed-in': case 'signed-out': refreshPlatform().then(() => render()); break;
      case 'update': if (ev.phase === 'available' || ev.phase === 'failed') refreshPlatform(); if (ev.phase === 'failed') toast('The update did not install: ' + ev.error + (ev.rolledBack ? ' Everything was put back as it was.' : ''), { sticky: true }); break;
      case 'open':
        if (ev.course) location.hash = ev.lesson ? '#/learn/' + ev.course + '?open=' + encodeURIComponent(ev.lesson) : '#/course/' + ev.course;
        try { window.focus(); } catch (e) { /* best effort */ }
        break;
      case 'suggest-open':
        if (ev.course) toast(el('div', {}, [ev.from === 'dayspring' ? el('span', { class: 'chip dayspring', text: 'Dayspring' }) : null, ev.title ? el('b', { text: ev.title + ' has started. ' }) : null, el('a', { href: '#/course/' + ev.course, text: 'Open the course' })]), { sticky: true });
        break;
      case 'reminder': if (!(S.eco && S.eco.quiet && S.eco.quiet.quiet)) toast(ev.text, { ms: 20000 }); break;
      case 'milestone': toast((ev.kind === 'unit' ? 'You finished ' : 'You passed ') + ev.title + '. Nice work!', { ms: 10000 }); break;
      case 'eco-in': if (ev.quiet) S.eco = Object.assign({}, S.eco, { quiet: ev.quiet }); break;
      default: break;
    }
  }
  const rerenderIf = (name) => () => { if (route().name === name) render(); };

  async function answer(offerId, accept) {
    try {
      await api('/api/hub/offers/' + encodeURIComponent(offerId) + (accept ? '/accept' : '/decline'), { method: 'POST' });
      document.querySelectorAll('[data-testid=offer-toast]').forEach((t) => t.remove());
      toast(accept ? 'Accepted. The course is downloading so it works offline.' : 'Declined. The sender will see that.');
      await loadCourses();
      if (route().name === 'home') render();
    } catch (e) { toast(e.message, { sticky: true }); }
  }

  /* ------------------------------------------------------------- chrome */
  async function refreshPlatform() {
    try { S.platform = await api('/api/platform'); } catch (e) { return; }
    try { S.eco = await api('/api/eco/state'); } catch (e) { S.eco = null; }
    paintChrome();
  }
  function setSync(online, text) {
    const p = $('#sync-pill');
    p.querySelector('.dot').className = 'dot ' + (online ? 'on' : 'off');
    p.querySelector('.txt').textContent = text;
  }
  function paintChrome() {
    const P = S.platform;
    if (!P) return;
    const h = P.hub || {};
    if (!h.configured) setSync(false, 'On this computer');
    else if (!h.signedIn) setSync(false, 'Not signed in');
    else setSync(h.online, h.online ? 'Synced' : 'Offline — saved here');
    $('#nav-owner').hidden = !h.owner;
    const ds = S.eco && (S.eco.peers || []).find((p) => p.app === 'dayspring' && p.running);
    $('#eco-pill').hidden = !ds;
    paintBanner();
  }
  function paintBanner() {
    const slot = $('#banner-slot');
    slot.innerHTML = '';
    const P = S.platform;
    const up = P && P.update && P.update.latest;
    if (!up) return;
    const b = el('div', { class: 'banner', role: 'region', 'aria-label': 'Update' }, [
      el('div', { class: 'grow' }, [el('b', { text: 'Lantern ' + up.latest + ' is ready.' }), ' You have ' + up.current + '. Your courses and progress are kept.']),
      el('button', { class: 'btn', onclick: () => whatsNewDialog(up) }, 'What’s new'),
      el('button', { class: 'btn primary', onclick: updateNow }, 'Update now'),
      el('button', { class: 'btn quiet', onclick: updateLater }, 'Next time I open Lantern'),
    ]);
    slot.appendChild(b);
  }
  function whatsNewDialog(up) {
    const d = el('dialog', {}, [el('h2', { text: up.title || ('Lantern ' + up.latest) }), md(up.notes || 'No notes were written for this version.'),
      el('div', { class: 'row', style: 'margin-top:16px' }, [el('button', { class: 'btn primary', onclick: () => { d.close(); updateNow(); } }, 'Update now'), el('button', { class: 'btn', onclick: () => d.close() }, 'Close')])]);
    document.body.appendChild(d); d.showModal(); d.addEventListener('close', () => d.remove());
  }
  async function updateNow() {
    toast('Updating Lantern… your data is backed up first. The page will reload by itself.', { sticky: true });
    try { await api('/api/updates/apply', { method: 'POST' }); }
    catch (e) { toast('The update did not install: ' + e.message, { sticky: true }); }
  }
  async function updateLater() {
    const r = await api('/api/updates/later', { method: 'POST' });
    toast(r.message);
    $('#banner-slot').innerHTML = '';
  }

  /* ------------------------------------------------------------- routing */
  function route() {
    const h = location.hash.replace(/^#/, '') || '/';
    const [path, qs] = h.split('?');
    const q = new URLSearchParams(qs || '');
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    if (!parts.length) return { name: 'home' };
    if (parts[0] === 'course' && parts[1]) return { name: 'course', id: parts[1], q };
    if (parts[0] === 'learn' && parts[1]) return { name: 'learn', id: parts[1], open: q.get('open') };
    if (parts[0] === 'whats-new') return { name: 'whats-new' };
    if (parts[0] === 'settings') return { name: 'settings', section: parts[1] || 'account' };
    if (parts[0] === 'owner') return { name: 'owner', tab: parts[1] || 'people' };
    if (pages[parts[0]]) return { name: parts[0], sub: parts[1] || null, q };
    return { name: 'home' };
  }

  let renderSeq = 0;
  async function render() {
    const r = route();
    const seq = ++renderSeq;
    const live = $('#main');
    const alive = () => seq === renderSeq;
    // every page but the player is built off-screen and shown when it is ready
    const main = r.name === 'learn' ? live : el('div', {});
    const show = () => { if (!alive() || main === live) return; live.replaceChildren(...main.childNodes); };
    if (S.playing && r.name !== 'learn') await closePlayer();
    if (r.name === 'course') reportHere({ course: r.id, ref: null, kind: 'overview', title: null });
    else if (r.name !== 'learn') reportHere({ course: null, ref: null, kind: r.name, title: null });
    document.body.classList.toggle('playing', r.name === 'learn');
    document.querySelectorAll('.bar nav a').forEach((a) => a.setAttribute('aria-current', a.dataset.nav === (r.name === 'course' || r.name === 'learn' ? 'home' : r.name) ? 'page' : 'false'));
    try {
      if (r.name === 'home') await renderHome(main);
      else if (r.name === 'course') await renderCourse(main, r.id);
      else if (r.name === 'learn') await renderPlayer(main, r.id, r.open, alive);
      else if (r.name === 'whats-new') await renderWhatsNew(main);
      else if (r.name === 'settings') await renderSettings(main, r.section);
      else if (r.name === 'owner') await renderOwner(main, r.tab);
      else if (pages[r.name]) await pages[r.name](main, r);
      show();
    } catch (e) {
      if (!alive()) return;
      main.innerHTML = '';
      main.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'That page did not load' }), el('p', { text: e.message }), el('a', { class: 'btn', href: '#/' }, 'Back to your courses')]));
      show();
    }
  }

  /* ---------------------------------------------------------------- home */
  async function loadCourses() {
    const j = await api('/api/courses');
    S.courses = j.courses || [];
    S.offers = j.offers || [];
    return j;
  }

  async function renderHome(main) {
    await loadCourses();
    const P = S.platform || {};
    const h = P.hub || {};
    main.innerHTML = '';
    main.appendChild(el('h1', { text: h.profile && h.profile.display_name ? 'Welcome back, ' + h.profile.display_name.split(' ')[0] : 'Your courses' }));
    main.appendChild(el('p', { class: 'lede', text: 'Everything here works offline. Your progress is saved on this computer first' + (h.signedIn ? ' and synced to your account whenever you are online.' : '.') }));

    if (!h.configured) {
      main.appendChild(el('section', { class: 'card welcome', 'data-testid': 'welcome', style: 'margin-bottom:16px' }, [
        el('h2', { text: 'Welcome to Lantern', style: 'margin-top:0' }),
        el('p', { text: 'Lantern is where your courses live. Lessons, exercises and grading all work on this computer, even offline.' }),
        el('ol', {}, [
          el('li', {}, [el('b', { text: 'Learning with someone? ' }), 'Whoever shares courses with you runs a ', el('b', { text: 'hub' }), ' (a small online account service). Connect to it under ', el('a', { href: '#/settings/account', 'data-testid': 'welcome-connect', text: 'Settings → Account & hub' }), ' with the address and public key they gave you, then create your account.']),
          el('li', {}, [el('b', { text: 'Then ' }), 'they add you as a friend (or give you a friend code or an invite code), and send you a course. It appears here as an invitation: press Accept and it downloads for offline use.']),
          el('li', {}, [el('b', { text: 'On your own? ' }), 'You do not need a hub. Add a course from a .lpack file below. Your progress stays on this computer.']),
        ]),
      ]));
    } else if (h.signedIn && !S.courses.length && !S.offers.length) {
      main.appendChild(el('section', { class: 'card welcome', 'data-testid': 'welcome-signed-in', style: 'margin-bottom:16px' }, [
        el('h2', { text: 'You are all set', style: 'margin-top:0' }),
        el('p', {}, ['Courses come from the person who runs your hub. Give them your ', el('a', { href: '#/friends', text: 'friend code' }), ' so they can add you and send you a course, or type an invite code they gave you below. Invitations appear at the top of this page.']),
      ]));
    }

    if (h.configured && !h.signedIn) {
      main.appendChild(el('div', { class: 'card', style: 'margin-bottom:16px' }, [
        el('h3', { text: 'Sign in to get your courses', style: 'margin-top:0' }),
        el('p', { class: 'muted', text: 'Create your account or sign in, and courses sent to you will appear here.' }),
        el('a', { class: 'btn primary', href: '#/settings/account', 'data-testid': 'go-signin' }, 'Sign in or create an account'),
      ]));
    }

    if (S.offers.length) {
      const box = el('section', { class: 'card invites', 'aria-label': 'Invitations', 'data-testid': 'invitations' }, [el('h2', { text: 'Invitations', style: 'margin-top:0' })]);
      S.offers.forEach((o) => box.appendChild(el('div', { class: 'invite', 'data-testid': 'invite' }, [
        el('div', { class: 'what' }, [el('b', { text: o.from_name + ' sent you ' + o.course_title }), o.course_description ? el('div', { class: 'muted', text: o.course_description }) : null, o.message ? el('blockquote', { text: o.message }) : null]),
        el('button', { class: 'btn primary', 'data-testid': 'accept', onclick: () => answer(o.id, true) }, 'Accept'),
        el('button', { class: 'btn', 'data-testid': 'decline', onclick: () => answer(o.id, false) }, 'Decline'),
      ])));
      main.appendChild(box);
    }

    const grid = el('div', { class: 'grid', 'data-testid': 'course-grid' });
    S.courses.forEach((c) => grid.appendChild(courseCard(c)));
    if (!S.courses.length) {
      grid.appendChild(el('div', { class: 'card' }, [el('h3', { text: 'No courses yet', style: 'margin-top:0' }),
        el('p', { class: 'muted', text: h.signedIn ? 'When someone sends you a course, it shows up above. You can also add a course from a file.' : 'Sign in to receive courses, or add a course from a file someone gave you.' })]));
    }
    main.appendChild(el('h2', { text: 'Courses' }));
    main.appendChild(grid);

    // more ways in
    const more = el('div', { class: 'grid', style: 'margin-top:24px' });
    if (h.signedIn) {
      const code = el('input', { type: 'text', placeholder: 'e.g. 7F3A9C21B4', 'aria-label': 'Invite code', autocomplete: 'off' });
      const msg = el('div', { class: 'muted' });
      more.appendChild(el('div', { class: 'card' }, [el('h3', { text: 'Have an invite code?', style: 'margin-top:0' }), code,
        el('div', { class: 'row', style: 'margin-top:10px' }, [el('button', { class: 'btn', onclick: async () => {
          try { const r = await api('/api/hub/redeem', { method: 'POST', body: { code: code.value } }); msg.textContent = r.offers ? 'Done — the invitation is waiting above.' : 'You already have everything that code offers.'; await loadCourses(); render(); }
          catch (e) { msg.textContent = e.message; }
        } }, 'Use code')]), msg]));
      const listed = el('div', { class: 'card' }, [el('h3', { text: 'More courses', style: 'margin-top:0' }), el('p', { class: 'muted', text: 'Loading…' })]);
      more.appendChild(listed);
      api('/api/hub/listed').then((j) => {
        listed.lastChild.remove();
        if (j.offline) { listed.appendChild(el('p', { class: 'muted', text: 'Available when you are online.' })); return; }
        if (!j.courses.length) { listed.appendChild(el('p', { class: 'muted', text: 'Nothing else is listed right now.' })); return; }
        j.courses.forEach((c) => listed.appendChild(el('div', { class: 'row', style: 'justify-content:space-between;padding:6px 0' }, [
          el('span', {}, [el('b', { text: c.title }), c.description ? el('div', { class: 'muted', text: c.description }) : null]),
          c.requested ? el('span', { class: 'tag', text: 'Requested' }) : el('button', { class: 'btn', onclick: async (e) => {
            const note = await ask('Anything you would like to say with your request? (optional)', { input: true, yes: 'Send the request', title: 'Ask for ' + c.title });
            if (note === null) return;
            try { await api('/api/hub/request', { method: 'POST', body: { course: c.id, message: note } }); e.target.replaceWith(el('span', { class: 'tag', text: 'Requested' })); }
            catch (err) { toast(err.message); }
          } }, 'Request'),
        ])));
      }).catch(() => { listed.lastChild.textContent = 'Available when you are online.'; });
    }
    const file = el('input', { type: 'file', accept: '.lpack,application/json', 'aria-label': 'Course file' });
    const fmsg = el('div', { class: 'muted' });
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      fmsg.textContent = 'Adding ' + f.name + '…';
      try { const r = await api('/api/packs/import', { method: 'POST', body: await f.text(), raw: true }); fmsg.textContent = 'Added. '; await loadCourses(); render(); toast('Added ' + r.id + ' ' + r.version + '.'); }
      catch (e) { fmsg.textContent = e.message; }
    });
    more.appendChild(el('div', { class: 'card' }, [el('h3', { text: 'Add a course from a file', style: 'margin-top:0' }),
      el('p', { class: 'muted', text: 'A course file ends in .lpack.' }), file, fmsg]));
    main.appendChild(more);
  }

  function courseCard(c) {
    const pct = c.percent || 0;
    const card = el('article', { class: 'card course-card', 'data-course': c.id, 'data-testid': 'course-' + c.id }, [
      el('div', { class: 'row', style: 'justify-content:space-between' }, [el('h3', { text: c.title }), c.level ? el('span', { class: 'tag', text: c.level }) : null]),
      c.description ? el('p', { class: 'muted', style: 'margin:0', text: c.description.length > 180 ? c.description.slice(0, 177) + '…' : c.description }) : null,
      el('div', { class: 'spacer' }),
    ]);
    if (c.installed) {
      card.appendChild(el('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Progress' }, el('i', { style: 'width:' + pct + '%' })));
      card.appendChild(el('div', { class: 'row', style: 'justify-content:space-between' }, [
        el('span', { class: 'muted', title: c.count ? measure(c) : '', text: pct + '% done' + (c.current ? ' · last: ' + c.current.title : '') }),
        el('a', { class: 'btn primary', href: '#/course/' + encodeURIComponent(c.id), 'data-testid': 'open-' + c.id }, c.started ? 'Continue' : 'Start'),
      ]));
    } else {
      const d = c.download || {};
      const bar = el('div', { class: 'progress', 'data-dl': c.id, hidden: d.phase !== 'downloading' }, el('i', { style: 'width:' + (d.total ? Math.round(d.received / d.total * 100) : 0) + '%' }));
      const state = el('span', { class: 'muted', 'data-dlmsg': c.id, text: d.phase === 'downloading' ? 'Downloading…' : d.phase === 'failed' ? 'The download failed: ' + d.error : 'Not downloaded yet' });
      card.appendChild(bar);
      card.appendChild(el('div', { class: 'row', style: 'justify-content:space-between' }, [state,
        el('button', { class: 'btn', 'data-testid': 'download-' + c.id, onclick: async (e) => {
          e.target.disabled = true;
          try { await api('/api/courses/' + encodeURIComponent(c.id) + '/download', { method: 'POST' }); } catch (err) { toast(err.message); e.target.disabled = false; }
        } }, d.phase === 'failed' ? 'Download again' : 'Download to use offline')]));
    }
    return card;
  }
  function paintDownload(ev) {
    const bar = document.querySelector('[data-dl="' + ev.course + '"]');
    const msg = document.querySelector('[data-dlmsg="' + ev.course + '"]');
    if (bar) { bar.hidden = ev.phase !== 'downloading'; bar.firstChild.style.width = (ev.total ? Math.round(ev.received / ev.total * 100) : 5) + '%'; }
    if (msg) msg.textContent = ev.phase === 'downloading' ? 'Downloading… ' + (ev.total ? Math.round(ev.received / ev.total * 100) + '%' : '') : ev.phase === 'failed' ? 'The download failed: ' + ev.error : 'Ready';
  }

  /* ------------------------------------------------------------ overview */
  async function renderCourse(main, id) {
    const ov = await api('/api/courses/' + encodeURIComponent(id) + '/overview');
    main.innerHTML = '';
    const go = (ref) => { location.hash = '#/learn/' + encodeURIComponent(id) + (ref ? '?open=' + encodeURIComponent(ref) : ''); };
    const target = ov.continue || ov.next;
    main.appendChild(el('a', { href: '#/', class: 'muted', text: '← Your courses' }));
    main.appendChild(el('h1', { text: ov.title, 'data-testid': 'overview-title' }));
    if (ov.description) main.appendChild(el('p', { class: 'lede', text: ov.description }));
    main.appendChild(el('div', { class: 'ov-head' }, [
      el('div', {}, [el('div', { class: 'big', 'data-testid': 'overview-percent', text: ov.percent + '%' }), el('div', { class: 'muted', 'data-testid': 'overview-measure', title: 'A step is one lesson, exercise, project milestone or unit check.', text: measure(ov) })]),
      el('div', {}, [el('div', { class: 'big', text: fmtMin(ov.minutesLeft) }), el('div', { class: 'muted', text: 'left, of about ' + fmtMin(ov.minutesTotal) })]),
      ov.seconds ? el('div', {}, [el('div', { class: 'big', text: fmtMin(ov.seconds / 60) }), el('div', { class: 'muted', text: 'spent so far' })]) : null,
      el('span', { class: 'grow', style: 'flex:1' }),
      el('button', { class: 'btn primary', 'data-testid': 'continue', onclick: () => go(target && target.id) }, ov.started ? 'Continue' + (target ? ': ' + target.title : '') : 'Start'),
    ]));
    main.appendChild(el('div', { class: 'progress', style: 'margin:14px 0 8px' }, el('i', { style: 'width:' + ov.percent + '%' })));

    const label = { done: 'Done', 'in-progress': 'In progress', 'not-started': 'Not started' };
    const status = (s) => el('span', { class: 'status ' + s, text: label[s] });
    ov.units.forEach((u) => {
      const open = u.done > 0 && u.done < u.count || (!ov.started && u.n === 1) || (target && (u.lessons.some((l) => l.id === target.id)));
      const list = el('ul', { class: 'items' });
      u.lessons.forEach((l) => {
        const li = el('li', { 'data-item': l.id }, [el('span', { class: 'kind', text: 'Lesson' }),
          el('button', { class: 'open', onclick: () => go(l.id) }, l.title), el('span', { class: 'muted', text: l.minutes ? l.minutes + ' min' : '' }), status(l.status)]);
        list.appendChild(li);
        if (l.exercises.length) list.appendChild(el('li', {}, el('ul', { class: 'sub' }, l.exercises.map((e) => el('li', {}, [el('span', { class: 'status ' + e.status, text: 'Exercise: ' + e.title })])))));
      });
      u.projects.forEach((p) => {
        list.appendChild(el('li', { 'data-item': p.id }, [el('span', { class: 'kind', text: 'Project' }), el('button', { class: 'open', onclick: () => go(p.id) }, p.title), el('span', { class: 'muted', text: p.minutes ? p.minutes + ' min' : '' }), status(p.status)]));
        list.appendChild(el('li', {}, el('ul', { class: 'sub' }, p.milestones.map((m) => el('li', {}, el('span', { class: 'status ' + m.status, text: 'Milestone: ' + m.title }))))));
      });
      if (u.check) list.appendChild(el('li', { 'data-item': u.check.id }, [el('span', { class: 'kind', text: 'Check' }), el('button', { class: 'open', onclick: () => go(u.check.id) }, u.check.title), el('span', { class: 'muted', text: u.check.minutes + ' min' }), status(u.check.status)]));
      main.appendChild(el('details', { class: 'unit', open: open ? true : null }, [
        el('summary', {}, [el('span', { class: 'n', text: 'Unit ' + u.n }), el('span', { class: 't', text: u.title }), el('span', { class: 'muted', text: u.done + ' / ' + u.count })]), list]));
    });

    // Tools: bring progress from the web version; saved copies; study time in Dayspring
    const tools = el('div', { class: 'grid', style: 'margin-top:28px' });
    tools.appendChild(el('div', { class: 'card' }, [el('h3', { text: 'Bring your progress from the web version', style: 'margin-top:0' }),
      el('p', { class: 'muted', text: 'On the web version, open Progress, press "Make a backup", copy all the text, and paste it here. Nothing you have done here is lost.' }),
      el('button', { class: 'btn', 'data-testid': 'import-open', onclick: () => importDialog(id) }, 'Paste a backup…')]));
    const ds = S.eco && (S.eco.peers || []).find((p) => p.app === 'dayspring' && p.running);
    tools.appendChild(el('div', { class: 'card' }, [el('h3', { text: 'Study time in Dayspring', style: 'margin-top:0' }),
      el('p', { class: 'muted', text: ds ? 'Add a regular study block for this course to your Dayspring schedule.' : 'When Dayspring is running on this computer, you can add study time to your schedule from here.' }),
      el('button', { class: 'btn', disabled: !ds, onclick: () => studyBlockDialog(id, ov.title) }, 'Add study time…')]));
    tools.appendChild(el('div', { class: 'card' }, [el('h3', { text: 'Saved copies', style: 'margin-top:0' }),
      el('p', { class: 'muted', text: 'Every time your progress is replaced (an import, or a newer copy from another computer) the old one is kept.' }),
      el('button', { class: 'btn', onclick: () => historyDialog(id) }, 'See saved copies…')]));
    main.appendChild(tools);
  }

  function importDialog(id) {
    const box = el('textarea', { 'aria-label': 'Backup text', placeholder: '{"lantern":"backup", …}', 'data-testid': 'import-text' });
    const msg = el('p', { class: 'muted' });
    const d = el('dialog', {}, [el('h2', { text: 'Paste your backup' }), box, msg, el('div', { class: 'row' }, [
      el('button', { class: 'btn primary', 'data-testid': 'import-go', onclick: async () => {
        try { const r = await api('/api/courses/' + encodeURIComponent(id) + '/import', { method: 'POST', body: { backup: box.value } }); msg.textContent = 'Imported. You are ' + r.overview.percent + '% through.'; try { localStorage.removeItem('lantern.shell.sync.' + id); } catch (e) { /* fine */ } setTimeout(() => { d.close(); render(); }, 900); }
        catch (e) { msg.textContent = e.message; msg.className = 'err'; }
      } }, 'Import'), el('button', { class: 'btn', onclick: () => d.close() }, 'Cancel')])]);
    document.body.appendChild(d); d.showModal(); d.addEventListener('close', () => d.remove());
  }

  async function historyDialog(id) {
    const j = await api('/api/courses/' + encodeURIComponent(id) + '/history');
    const list = el('div', {});
    if (!j.history.length) list.appendChild(el('p', { class: 'muted', text: 'No saved copies yet.' }));
    j.history.forEach((h) => list.appendChild(el('div', { class: 'row', style: 'justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--rule)' }, [
      el('span', { text: fmtWhen(h.at) + ' — ' + h.reason }),
      el('button', { class: 'btn', onclick: async () => { if (!(await ask('Go back to this copy? What you have now is kept as a saved copy too.', { yes: 'Use this copy' }))) return; await api('/api/courses/' + encodeURIComponent(id) + '/restore', { method: 'POST', body: { id: h.id } }); try { localStorage.removeItem('lantern.shell.sync.' + id); } catch (e) { /* fine */ } d.close(); render(); } }, 'Use this copy')])));
    const d = el('dialog', {}, [el('h2', { text: 'Saved copies' }), list, el('div', { class: 'row', style: 'margin-top:12px' }, el('button', { class: 'btn', onclick: () => d.close() }, 'Close'))]);
    document.body.appendChild(d); d.showModal(); d.addEventListener('close', () => d.remove());
  }

  function studyBlockDialog(id, title) {
    const time = el('input', { type: 'time', value: '19:00' });
    const mins = el('input', { type: 'number', value: '30', min: '10', max: '240' });
    const days = [['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6]].map(([n, v]) => { const c = el('input', { type: 'checkbox', value: v, checked: v >= 1 && v <= 5 ? true : null }); return el('label', { style: 'margin-right:10px' }, [c, ' ' + n]); });
    const msg = el('p', { class: 'muted' });
    const d = el('dialog', {}, [el('h2', { text: 'Study time for ' + title }), el('label', { class: 'f' }, [el('span', { text: 'Time' }), time]), el('label', { class: 'f' }, [el('span', { text: 'Minutes' }), mins]), el('div', {}, days), msg,
      el('div', { class: 'row', style: 'margin-top:12px' }, [el('button', { class: 'btn primary', onclick: async () => {
        try { await api('/api/local/study-block', { method: 'POST', body: { course: id, time: time.value, minutes: Number(mins.value), days: days.map((l) => l.firstChild).filter((c) => c.checked).map((c) => Number(c.value)) } }); msg.textContent = 'Sent to Dayspring.'; setTimeout(() => d.close(), 900); }
        catch (e) { msg.textContent = e.message; }
      } }, 'Add to Dayspring'), el('button', { class: 'btn', onclick: () => d.close() }, 'Cancel')])]);
    document.body.appendChild(d); d.showModal(); d.addEventListener('close', () => d.remove());
  }

  /* ------------------------------------------------ where the learner is */
  // The page open right now. The course page says where it is (a "nav"
  // message whenever the learner moves); the assistant and the resource finder
  // use it, and so does the owner's "studying now" column.
  S.here = { course: null, ref: null, kind: null, title: null };
  let hereTimer = null;
  function reportHere(h) {
    const same = S.here.course === h.course && S.here.ref === h.ref && S.here.kind === h.kind;
    S.here = Object.assign({}, h);
    if (same) return;
    fire('here', S.here);
    clearTimeout(hereTimer);
    hereTimer = setTimeout(() => { api('/api/assistant/here', { method: 'POST', body: S.here }).catch(() => {}); }, 250);
  }

  /* -------------------------------------------------------------- player */
  const metaKey = (id) => 'lantern.shell.sync.' + id;
  const readMeta = (id) => { try { return JSON.parse(localStorage.getItem(metaKey(id)) || '{}'); } catch (e) { return {}; } };
  const writeMeta = (id, m) => { try { localStorage.setItem(metaKey(id), JSON.stringify(m)); } catch (e) { /* storage blocked */ } };
  function readKeys(keys) { const out = {}; keys.forEach((k) => { try { const v = localStorage.getItem(k); if (v !== null) out[k] = v; } catch (e) { /* blocked */ } }); return out; }

  async function renderPlayer(main, id, openRef, alive) {
    const stillHere = () => !alive || alive();
    if (S.playing && S.playing.id === id) {
      // already open: just move the course to the lesson
      if (openRef && S.playing.frame.contentWindow) S.playing.frame.contentWindow.postMessage({ lantern: 'go', id: openRef }, location.origin);
      return;
    }
    let st = await api('/api/courses/' + encodeURIComponent(id) + '/state' + (openRef ? '?open=' + encodeURIComponent(openRef) : ''));
    if (!stillHere()) return;
    const keys = st.storageKeys || [];
    const meta = readMeta(id);
    if (meta.dirty) {
      // changes made here that never reached the database (the window closed
      // too fast): send them first, then take the merged copy back
      try { await api('/api/courses/' + encodeURIComponent(id) + '/state', { method: 'PUT', body: { keys: readKeys(keys), savedAt: Math.max(Date.now(), (st.savedAt || 0) + 1) } }); } catch (e) { /* kept; tried again on the next change */ }
      st = await api('/api/courses/' + encodeURIComponent(id) + '/state' + (openRef ? '?open=' + encodeURIComponent(openRef) : ''));
    }
    keys.forEach((k) => { try { if (st.keys[k] !== undefined) localStorage.setItem(k, st.keys[k]); else localStorage.removeItem(k); } catch (e) { /* blocked */ } });
    writeMeta(id, { savedAt: st.savedAt, dirty: false });
    if (!stillHere()) return;

    main.innerHTML = '';
    const pctEl = el('span', { class: 'muted', 'data-testid': 'player-percent' });
    // ?host=lantern: the course knows the app is around it, and leaves the header to the app
    const frame = el('iframe', { title: st.title, src: '/packs/' + encodeURIComponent(id) + '/' + (st.entry || 'index.html') + '?host=lantern', 'data-testid': 'player-frame', allow: 'clipboard-write' });
    const railBtn = el('button', { class: 'btn quiet', type: 'button', 'data-testid': 'lessons-btn', title: 'Show or hide the list of lessons', 'aria-label': 'Lessons' }, '☰ Lessons');
    railBtn.addEventListener('click', () => { try { frame.contentWindow.postMessage({ lantern: 'rail' }, location.origin); } catch (e) { /* closed */ } });
    main.appendChild(el('div', { class: 'player' }, [
      el('div', { class: 'player-bar' }, [el('a', { class: 'btn quiet', href: '#/course/' + encodeURIComponent(id) }, '← Overview'), railBtn, el('span', { class: 't', text: st.title }), pctEl,
        el('button', { class: 'btn quiet', type: 'button', 'data-testid': 'resources-btn', title: 'Videos, articles and docs about this lesson', onclick: () => window.dispatchEvent(new CustomEvent('lantern:resources')) }, 'Resources')]),
      frame,
    ]));
    let timer = null, saveWarned = false;
    const save = async (beacon) => {
      clearTimeout(timer); timer = null;
      const body = { keys: readKeys(keys), savedAt: Date.now() };
      writeMeta(id, { savedAt: body.savedAt, dirty: true });
      try {
        const r = await api('/api/courses/' + encodeURIComponent(id) + '/state', { method: 'PUT', body, keepalive: !!beacon });
        writeMeta(id, { savedAt: r.savedAt, dirty: false });
        saveWarned = false;
        refreshPercent();
      } catch (e) {
        if (!(e.status === 409 && e.body && e.body.keys) && !saveWarned) {
          // kept in this window and marked unsaved: the next change (or opening
          // the course again) tries again; the person hears about it once
          saveWarned = true;
          toast(el('div', { 'data-testid': 'save-failed' }, [el('b', { text: 'Your latest progress is not saved in Lantern yet. ' }), e.message + ' It is kept in this window, and Lantern tries again with your next change.']), { sticky: true });
        }
        if (e.status === 409 && e.body && e.body.keys) {
          // a newer copy exists (another window): take it and reload the course
          keys.forEach((k) => { try { if (e.body.keys[k] !== undefined) localStorage.setItem(k, e.body.keys[k]); } catch (x) { /* blocked */ } });
          writeMeta(id, { savedAt: e.body.savedAt, dirty: false });
          frame.contentWindow.location.reload();
        }
      }
    };
    const onStorage = (ev) => { if (ev.key && keys.indexOf(ev.key) >= 0) { writeMeta(id, Object.assign(readMeta(id), { dirty: true })); clearTimeout(timer); timer = setTimeout(save, 700); } };
    window.addEventListener('storage', onStorage);
    const onHide = () => { if (timer) save(true); };
    window.addEventListener('pagehide', onHide);
    const refreshPercent = async () => { try { const ov = await api('/api/courses/' + encodeURIComponent(id) + '/overview'); pctEl.textContent = ov.percent + '% · ' + measure(ov); pctEl.title = 'A step is one lesson, exercise, project milestone or unit check.'; } catch (e) { /* fine */ } };
    refreshPercent();
    // the person's editor and appearance settings go into the course when it
    // opens; changes the course reports come back and follow them everywhere
    const pushPrefs = (p) => { try { frame.contentWindow.postMessage(Object.assign({ lantern: 'settings' }, p || {}), location.origin); } catch (e) { /* closed */ } };
    reportHere({ course: id, ref: openRef || null, kind: openRef ? null : 'course', title: null });
    const onMsg = (e) => {
      if (e.source !== frame.contentWindow || !e.data) return;
      if (e.data.lantern === 'nav') { reportHere({ course: id, ref: String(e.data.id || '') || null, kind: e.data.kind || null, title: e.data.title || null }); return; }
      if (e.data.lantern !== 'settings-changed') return;
      api('/api/prefs', { method: 'PUT', body: { editor: e.data.editor, appearance: e.data.appearance } }).catch(() => {});
    };
    window.addEventListener('message', onMsg);
    const offPrefs = (ev) => { if (!ev.local) pushPrefs(ev.prefs); };
    on('prefs', offPrefs);
    // activity inside the course counts as using Lantern
    frame.addEventListener('load', () => {
      api('/api/prefs').then((p) => { if (p && (p.editor || p.appearance)) pushPrefs(p); }).catch(() => {});
      try { ['pointerdown', 'keydown'].forEach((t) => frame.contentWindow.document.addEventListener(t, activity, { passive: true })); } catch (e) { /* not ours */ }
    });
    S.playing = { id, frame, close: async () => { window.removeEventListener('storage', onStorage); window.removeEventListener('pagehide', onHide); window.removeEventListener('message', onMsg); S.listeners.prefs = (S.listeners.prefs || []).filter((f) => f !== offPrefs); if (timer) await save(); } };
    api('/api/activity', { method: 'POST', body: { course: id, lesson: openRef || null, status: 'studying' } }).catch(() => {});
  }
  async function closePlayer() {
    const p = S.playing;
    S.playing = null;
    if (p) await p.close();
    api('/api/activity', { method: 'POST', body: { course: null, lesson: null, status: 'browsing' } }).catch(() => {});
  }

  let lastActivity = 0;
  function activity() {
    if (Date.now() - lastActivity < 60000) return;
    lastActivity = Date.now();
    api('/api/activity', { method: 'POST', body: {} }).catch(() => {});
  }
  ['pointerdown', 'keydown'].forEach((t) => document.addEventListener(t, activity, { passive: true }));

  /* ---------------------------------------------------------- what's new */
  async function renderWhatsNew(main) {
    const j = await api('/api/updates');
    main.innerHTML = '';
    main.appendChild(el('h1', { text: 'What’s new' }));
    main.appendChild(el('p', { class: 'lede', text: 'Every update to Lantern and to your courses, newest first. Updates never touch your progress.' }));
    const unseen = new Set(j.unseen || []);
    if (!j.log.length) main.appendChild(el('p', { class: 'muted', text: 'Nothing yet.' }));
    j.log.forEach((row) => main.appendChild(el('article', { class: 'card', style: 'margin-bottom:12px' + (unseen.has(row.id) ? ';border-color:var(--accent)' : '') }, [
      el('div', { class: 'row', style: 'justify-content:space-between' }, [el('h3', { style: 'margin:0', text: row.title || (row.subject + ' ' + (row.to_version || '')) }), el('span', { class: 'muted', text: fmtWhen(row.at) })]),
      el('p', { class: row.status === 'installed' ? 'muted' : 'err', text: row.message }),
      row.notes ? md(row.notes) : null,
    ])));
    api('/api/updates/seen', { method: 'POST' }).catch(() => {});
  }

  /* ------------------------------------------------------------ settings */
  function registerSettings(section) { settingsSections.push(section); settingsSections.sort((a, b) => (a.order || 50) - (b.order || 50)); }

  async function renderSettings(main, sectionId) {
    main.innerHTML = '';
    main.appendChild(el('h1', { text: 'Settings' }));
    const nav = el('nav', { 'aria-label': 'Settings sections' });
    const body = el('section', {});
    settingsSections.forEach((s) => nav.appendChild(el('a', { href: '#/settings/' + s.id, 'aria-current': s.id === sectionId ? 'page' : 'false', text: s.title })));
    main.appendChild(el('div', { class: 'settings' }, [nav, body]));
    const sec = settingsSections.find((s) => s.id === sectionId) || settingsSections[0];
    body.appendChild(el('h2', { style: 'margin-top:0', text: sec.title }));
    await sec.render(body);
  }

  // Hub & account
  registerSettings({ id: 'account', title: 'Account & hub', order: 10, render: async (box) => {
    const h = await api('/api/hub');
    if (!h.configured) {
      const url = el('input', { type: 'url', placeholder: 'https://xxxx.supabase.co', 'data-testid': 'hub-url' });
      const key = el('input', { type: 'text', placeholder: 'eyJ… (the anon public key)', 'data-testid': 'hub-key' });
      const msg = el('p', { class: 'muted' });
      box.appendChild(el('p', { class: 'muted', text: 'Lantern works on its own. To receive courses from someone and sync your progress, connect it to their hub. They will give you two things: the hub address and its public key.' }));
      box.appendChild(el('label', { class: 'f' }, [el('span', { text: 'Hub address' }), url]));
      box.appendChild(el('label', { class: 'f' }, [el('span', { text: 'Public key' }), key]));
      box.appendChild(el('button', { class: 'btn primary', 'data-testid': 'hub-connect', onclick: async () => { try { await api('/api/hub/configure', { method: 'POST', body: { url: url.value, anonKey: key.value } }); await refreshPlatform(); render(); } catch (e) { msg.textContent = e.message; msg.className = 'err'; } } }, 'Connect'));
      box.appendChild(msg);
      return;
    }
    box.appendChild(el('p', { class: 'muted', text: 'Connected to ' + h.hubUrl + '.' }));
    if (!h.signedIn) {
      const tabs = el('div', { class: 'tabs', role: 'tablist' });
      const pane = el('div', {});
      const show = (which) => { tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', b.dataset.t === which ? 'true' : 'false')); pane.innerHTML = ''; (which === 'code' ? codeForm : which === 'link' ? linkForm : which === 'signup' ? signupForm : signinForm)(pane); };
      // the email option: a sign-in link (works with Supabase's default email),
      // or a 6-digit code when this hub's email is set up to include one
      [['signup', 'Create an account'], ['signin', 'Sign in'], h.emailCode ? ['code', 'Email me a code'] : ['link', 'Email me a link']].forEach(([t, n]) => tabs.appendChild(el('button', { class: 'btn', role: 'tab', 'data-t': t, 'data-testid': 'tab-' + t, onclick: () => show(t) }, n)));
      box.appendChild(tabs); box.appendChild(pane);
      show('signup');
      return;
    }
    const p = h.profile || {};
    const name = el('input', { type: 'text', value: p.display_name || '' });
    box.appendChild(el('p', {}, ['Signed in as ', el('b', { text: p.display_name || p.email }), ' (' + p.email + ')', p.role === 'owner' ? el('span', { class: 'tag', style: 'margin-left:8px', text: 'Owner' }) : null]));
    box.appendChild(el('label', { class: 'f' }, [el('span', { text: 'Your name (what others see)' }), name]));
    box.appendChild(el('div', { class: 'row' }, [el('button', { class: 'btn', onclick: async () => { await api('/api/hub/name', { method: 'POST', body: { name: name.value } }); toast('Saved.'); refreshPlatform(); } }, 'Save name'),
      el('button', { class: 'btn', onclick: async () => { await api('/api/hub/sync', { method: 'POST' }); toast('Synced.'); refreshPlatform(); } }, 'Sync now'),
      el('button', { class: 'btn danger', onclick: async () => { if (!(await ask('Sign out? Your courses and progress stay on this computer.', { yes: 'Sign out', danger: true }))) return; await api('/api/hub/signout', { method: 'POST' }); await refreshPlatform(); render(); } }, 'Sign out')]));
    if (!p.owner_exists) {
      const code = el('input', { type: 'text', placeholder: 'the claim code from the hub setup', 'data-testid': 'claim-code' });
      const msg = el('p', { class: 'muted' });
      box.appendChild(el('div', { class: 'card', style: 'margin-top:20px' }, [el('h3', { style: 'margin-top:0', text: 'I set up this hub' }),
        el('p', { class: 'muted', text: 'If you created this hub, enter the one-time claim code shown when you ran its setup. You become its owner: you can send courses and see everyone’s progress.' }),
        code, el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'btn', 'data-testid': 'claim-go', onclick: async () => { try { await api('/api/hub/claim-owner', { method: 'POST', body: { code: code.value } }); await refreshPlatform(); render(); } catch (e) { msg.textContent = e.message; } } }, 'Claim')), msg]));
    }
  } });
  function signupForm(pane) {
    const name = el('input', { type: 'text', autocomplete: 'name', 'data-testid': 'su-name' });
    const email = el('input', { type: 'email', autocomplete: 'email', 'data-testid': 'su-email' });
    const pw = el('input', { type: 'password', autocomplete: 'new-password', 'data-testid': 'su-password' });
    const msg = el('p', { class: 'muted' });
    pane.append(el('label', { class: 'f' }, [el('span', { text: 'Your name' }), name]), el('label', { class: 'f' }, [el('span', { text: 'Email' }), email]),
      el('label', { class: 'f' }, [el('span', { text: 'Password (6 or more characters)' }), pw]),
      el('button', { class: 'btn primary', 'data-testid': 'su-go', onclick: async () => {
        try { const r = await api('/api/hub/signup', { method: 'POST', body: { name: name.value, email: email.value, password: pw.value } });
          if (r.confirm) { msg.textContent = 'Check your email and press the link in it, then come back and sign in.'; return; }
          await refreshPlatform(); location.hash = '#/'; }
        catch (e) { msg.textContent = e.message; msg.className = 'err'; }
      } }, 'Create my account'), msg);
  }
  function signinForm(pane) {
    const email = el('input', { type: 'email', autocomplete: 'email', 'data-testid': 'si-email' });
    const pw = el('input', { type: 'password', autocomplete: 'current-password', 'data-testid': 'si-password' });
    const msg = el('p', { class: 'muted' });
    pane.append(el('label', { class: 'f' }, [el('span', { text: 'Email' }), email]), el('label', { class: 'f' }, [el('span', { text: 'Password' }), pw]),
      el('button', { class: 'btn primary', 'data-testid': 'si-go', onclick: async () => {
        try { await api('/api/hub/signin', { method: 'POST', body: { email: email.value, password: pw.value } }); await refreshPlatform(); location.hash = '#/'; }
        catch (e) { msg.textContent = e.message; msg.className = 'err'; }
      } }, 'Sign in'), msg);
  }
  function linkForm(pane) {
    const email = el('input', { type: 'email', autocomplete: 'email', 'data-testid': 'link-email' });
    const msg = el('p', { class: 'muted', 'aria-live': 'polite' });
    pane.append(el('p', { class: 'muted', text: 'No password needed: we email you a sign-in link. Open the email on this computer and press the link; Lantern signs you in. If you do not have an account yet, this creates one.' }),
      el('label', { class: 'f' }, [el('span', { text: 'Email' }), email]),
      el('button', { class: 'btn primary', 'data-testid': 'link-send', onclick: async () => {
        try { await api('/api/hub/link/send', { method: 'POST', body: { email: email.value } }); msg.className = 'muted'; msg.textContent = 'Sent. Open the email on this computer and press “Sign in” (it can take a minute; check spam too).'; }
        catch (e) { msg.textContent = e.message; msg.className = 'err'; }
      } }, 'Email me a link'), msg);
  }
  function codeForm(pane) {
    const email = el('input', { type: 'email', autocomplete: 'email', 'data-testid': 'code-email' });
    const code = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', 'data-testid': 'code-code', placeholder: '6 digits' });
    const msg = el('p', { class: 'muted' });
    pane.append(el('p', { class: 'muted', text: 'No password needed: we email you a 6-digit code. If you do not have an account yet, this creates one.' }),
      el('label', { class: 'f' }, [el('span', { text: 'Email' }), email]),
      el('button', { class: 'btn', 'data-testid': 'code-send', onclick: async () => { try { await api('/api/hub/code/send', { method: 'POST', body: { email: email.value } }); msg.textContent = 'Sent. Check your email for the code.'; } catch (e) { msg.textContent = e.message; } } }, 'Email me a code'),
      el('label', { class: 'f' }, [el('span', { text: 'Code' }), code]),
      el('button', { class: 'btn primary', 'data-testid': 'code-go', onclick: async () => { try { await api('/api/hub/code/verify', { method: 'POST', body: { email: email.value, code: code.value } }); await refreshPlatform(); location.hash = '#/'; } catch (e) { msg.textContent = e.message; msg.className = 'err'; } } }, 'Sign in'), msg);
  }

  // Updates
  registerSettings({ id: 'updates', title: 'Updates', order: 20, render: async (box) => {
    const j = await api('/api/updates');
    const P = S.platform || {};
    box.appendChild(el('p', {}, ['This is Lantern ', el('b', { text: P.version || '' }), '. ', j.status.message || '']));
    const choices = [['ask', 'Ask me first', 'Show me when an update is ready; I choose when.'], ['next-launch', 'Next time I open Lantern', 'Install it quietly the next time Lantern starts.'], ['idle', 'When I am not using Lantern', 'Install it in the background after a while without use.']];
    const form = el('fieldset', { style: 'border:0;padding:0' }, [el('legend', { class: 'sr', text: 'When to update' })]);
    choices.forEach(([v, t, d]) => form.appendChild(el('label', { class: 'f', style: 'display:flex;gap:10px' }, [el('input', { type: 'radio', name: 'um', value: v, checked: j.mode === v ? true : null, onchange: async () => { await api('/api/updates/mode', { method: 'PUT', body: { mode: v } }); toast('Saved.'); } }), el('span', {}, [el('b', { text: t }), el('div', { class: 'muted', text: d })])])));
    box.appendChild(form);
    box.appendChild(el('p', { class: 'muted', text: 'Before any update, your data is backed up. If an update fails, Lantern puts everything back as it was.' }));
    box.appendChild(el('button', { class: 'btn', onclick: async () => { try { const r = await api('/api/updates/check', { method: 'POST' }); toast(r.available ? 'Lantern ' + r.latest + ' is available.' : 'Lantern is up to date.'); refreshPlatform(); } catch (e) { toast(e.message); } } }, 'Check now'));
  } });

  // General
  registerSettings({ id: 'general', title: 'Reminders', order: 30, render: async (box) => {
    const s = await api('/api/settings');
    const on = el('input', { type: 'checkbox', checked: s.reminders.enabled ? true : null });
    const time = el('input', { type: 'time', value: s.reminders.time });
    box.appendChild(el('label', { class: 'f' }, [on, ' Remind me to study']));
    box.appendChild(el('label', { class: 'f' }, [el('span', { text: 'At' }), time]));
    box.appendChild(el('button', { class: 'btn', onclick: async () => { await api('/api/settings', { method: 'PUT', body: { reminders: { enabled: on.checked, time: time.value, days: s.reminders.days } } }); toast('Saved.'); } }, 'Save'));
    box.appendChild(el('p', { class: 'muted', text: 'If Dayspring is running, the reminder is announced there too. Reminders wait while Dayspring says you are in a call or in quiet hours.' }));
  } });

  // Appearance
  registerSettings({ id: 'appearance', title: 'Appearance', order: 40, render: async (box) => {
    const cur = (() => { try { return localStorage.getItem('lantern.shell.theme') || ''; } catch (e) { return ''; } })();
    const sel = el('select', { onchange: () => { try { if (sel.value) localStorage.setItem('lantern.shell.theme', sel.value); else localStorage.removeItem('lantern.shell.theme'); } catch (e) { /* blocked */ } applyPalette(); } },
      [['', 'Match my computer (light or dark)'], ['evening', 'Lantern evening · dark'], ['day', 'Lantern day · light']]
        .map(([v, n]) => el('option', { value: v, selected: v === cur ? true : null }, n)));
    box.appendChild(el('label', { class: 'f' }, [el('span', { text: 'Colours' }), sel]));
    const hc = el('input', { type: 'checkbox', 'data-testid': 'high-contrast', checked: stored('lantern.shell.contrast') === 'high' ? true : null, onchange: () => { store('lantern.shell.contrast', hc.checked ? 'high' : ''); applyPalette(); } });
    box.appendChild(el('label', { class: 'f' }, [hc, ' High contrast (stronger text and edges)']));
    const rm = el('input', { type: 'checkbox', checked: stored('lantern.shell.motion') === 'reduced' ? true : null, onchange: () => { store('lantern.shell.motion', rm.checked ? 'reduced' : ''); applyPalette(); } });
    box.appendChild(el('label', { class: 'f' }, [rm, ' Less motion (no flicker or slides)']));
    box.appendChild(el('p', { class: 'muted', text: 'Each course keeps its own colour and code-editor settings inside the course.' }));
  } });

  // Dayspring
  registerSettings({ id: 'dayspring', title: 'Dayspring', order: 50, render: async (box) => {
    const eco = await api('/api/eco/state');
    const s = await api('/api/settings');
    const ds = (eco.peers || []).find((p) => p.app === 'dayspring');
    box.appendChild(el('p', {}, ds && ds.running ? [el('span', { class: 'dot on' }), ' Dayspring ' + ds.version + ' is running and connected.'] : [el('span', { class: 'dot' }), ' Dayspring is not running on this computer. Lantern works fully on its own.']));
    const ann = el('input', { type: 'checkbox', checked: s.dayspring ? true : null, onchange: async () => { await api('/api/settings', { method: 'PUT', body: { dayspring: ann.checked } }); toast('Saved.'); } });
    box.appendChild(el('label', { class: 'f' }, [ann, ' Let Dayspring announce course invitations, milestones and reminders']));
    if (eco.quiet && eco.quiet.quiet) box.appendChild(el('p', { class: 'muted', text: 'Dayspring says it is quiet time right now, so Lantern is holding its reminders.' }));
  } });

  // Your data
  registerSettings({ id: 'data', title: 'Your data', order: 60, render: async (box) => {
    const j = await api('/api/backups');
    const P = S.platform || {};
    box.appendChild(el('p', {}, ['Everything you do is kept in ', el('code', { text: P.dataDir || '' }), '. Updates never touch this folder.']));
    box.appendChild(el('button', { class: 'btn', onclick: async () => { await api('/api/backups', { method: 'POST' }); toast('Backed up.'); render(); } }, 'Back up now'));
    const t = el('table', { class: 'data', style: 'margin-top:14px' }, [el('tr', {}, [el('th', { text: 'Backup' }), el('th', { text: 'When' }), el('th', { text: 'Size' })])]);
    j.backups.forEach((b) => t.appendChild(el('tr', {}, [el('td', { text: b.name }), el('td', { text: fmtWhen(b.at) }), el('td', { text: Math.round(b.size / 1024) + ' KB' })])));
    box.appendChild(el('div', { class: 'scroll-x' }, t));
    box.appendChild(el('p', { class: 'muted', text: 'The newest ' + 10 + ' backups are kept. Lantern also backs up by itself before every update.' }));
  } });

  // The AI, the voice, the sound and the lantern's look: registered by assistant.js.

  /* --------------------------------------------------------------- owner */
  async function renderOwner(main, tab) {
    main.innerHTML = '';
    main.appendChild(el('h1', { text: 'Owner' }));
    main.appendChild(el('p', { class: 'lede', text: 'Everyone who uses your hub, the courses you share, and how each person is doing.' }));
    const tabs = el('div', { class: 'tabs', role: 'tablist' });
    [['people', 'People'], ['offers', 'Offers'], ['courses', 'Courses'], ['groups', 'Groups'], ['requests', 'Requests']].forEach(([t, n]) =>
      tabs.appendChild(el('a', { class: 'btn', role: 'tab', href: '#/owner/' + t, 'aria-selected': t === tab ? 'true' : 'false', 'data-testid': 'owner-tab-' + t }, n)));
    main.appendChild(tabs);
    const box = el('div', {});
    main.appendChild(box);
    const call = (fn, args) => api('/api/hub/owner/' + fn, { method: 'POST', body: args || {} });
    if (tab === 'people') return ownerPeople(box, call);
    if (tab === 'offers') return ownerOffers(box, call);
    if (tab === 'courses') return ownerCourses(box, call);
    if (tab === 'groups') return ownerGroups(box, call);
    if (tab === 'requests') return ownerRequests(box, call);
  }

  async function ownerPeople(box, call) {
    const [people, courses] = await Promise.all([call('people'), call('courses')]);
    const chosen = new Set();
    const t = el('table', { class: 'data', 'data-testid': 'people-table' });
    const all = el('input', { type: 'checkbox', 'aria-label': 'Select everyone', onchange: () => { t.querySelectorAll('input[data-person]').forEach((c) => { c.checked = all.checked; if (c.checked) chosen.add(c.dataset.person); else chosen.delete(c.dataset.person); }); } });
    t.appendChild(el('tr', {}, [el('th', {}, all), el('th', { text: 'Person' }), el('th', { text: 'Status' }), el('th', { text: 'Lantern' }), el('th', { text: 'Studying' }), el('th', { text: 'Progress' })]));
    people.forEach((p) => {
      const check = p.id && p.role !== 'owner' ? el('input', { type: 'checkbox', 'data-person': p.id, 'aria-label': 'Select ' + p.display_name, onchange: (e) => { if (e.target.checked) chosen.add(p.id); else chosen.delete(p.id); } }) : null;
      const prog = (p.courses || []).map((c) => { const co = courses.find((x) => x.id === c.course_id); return (co ? co.title : c.course_id) + ' ' + c.percent + '%'; }).join(' · ');
      t.appendChild(el('tr', { 'data-testid': 'person-row', 'data-email': p.email || '' }, [
        el('td', {}, check),
        el('td', {}, [el('b', { text: p.display_name || p.email }), el('div', { class: 'muted', text: p.email || '' }), p.role === 'owner' ? el('span', { class: 'tag', text: 'Owner' }) : p.pending_invite ? el('span', { class: 'tag', text: 'Invited by email' }) : null]),
        el('td', {}, p.pending_invite ? 'Not signed up yet' : [el('span', { class: 'dot ' + (p.online ? 'on' : '') }), p.online ? ' Online' : ' ' + ago(p.last_seen)]),
        el('td', { text: p.app_version || '' }),
        el('td', { 'data-testid': 'person-current', text: studying(p, courses) }),
        el('td', { 'data-testid': 'person-progress', text: prog || (p.offered ? 'Offered: ' + p.offered.join(', ') : '') }),
      ]));
    });
    box.appendChild(el('div', { class: 'row', style: 'margin-bottom:12px' }, [
      el('button', { class: 'btn primary', 'data-testid': 'send-course', onclick: () => sendDialog([...chosen], courses, call) }, 'Send course…'),
      el('span', { class: 'muted', text: 'Tick people, or send to an email address in the next step.' })]));
    box.appendChild(el('div', { class: 'scroll-x' }, t));
    clearTimeout(peopleTimer);
    peopleTimer = setTimeout(function again() {
      if (route().name !== 'owner' || route().tab !== 'people') return;
      const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (chosen.size || typing || document.querySelector('dialog[open]')) { peopleTimer = setTimeout(again, 20000); return; }
      render();
    }, 20000);
  }
  let peopleTimer = null;
  const courseTitle = (courses, id) => { const c = courses.find((x) => x.id === id); return c ? c.title : id; };
  // "ColdFusion · cfoutput and the Hash Marks": live when they are in a course now, else where they last were
  function studying(p, courses) {
    const sums = p.courses || [];
    if (p.online && p.current_course) {
      const s = sums.find((x) => x.course_id === p.current_course);
      const lesson = s && s.current_ref === p.current_lesson ? s.current_title : p.current_lesson;
      return 'Now: ' + courseTitle(courses, p.current_course) + (lesson ? ' · ' + lesson : '');
    }
    const last = sums.slice().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
    return last && last.current_title ? courseTitle(courses, last.course_id) + ' · ' + last.current_title : '';
  }

  function sendDialog(userIds, courses, call) {
    const sel = el('select', { 'data-testid': 'send-course-select' }, courses.map((c) => el('option', { value: c.id }, c.title + (c.status === 'draft' ? ' (draft)' : ''))));
    const msgIn = el('textarea', { maxlength: '500', placeholder: 'A short note (optional)', 'data-testid': 'send-message' });
    const emails = el('input', { type: 'text', placeholder: 'friend@example.com, other@example.com', 'data-testid': 'send-emails' });
    const out = el('p', { class: 'muted' });
    const d = el('dialog', {}, [el('h2', { text: 'Send a course' }),
      el('p', { class: 'muted', text: userIds.length ? 'To ' + userIds.length + ' selected ' + (userIds.length === 1 ? 'person' : 'people') + '.' : 'Nobody is ticked: add email addresses below.' }),
      el('label', { class: 'f' }, [el('span', { text: 'Course' }), sel]),
      el('label', { class: 'f' }, [el('span', { text: 'Also send to these email addresses (people without an account get it when they sign up)' }), emails]),
      el('label', { class: 'f' }, [el('span', { text: 'Message' }), msgIn]), out,
      el('div', { class: 'row' }, [el('button', { class: 'btn primary', 'data-testid': 'send-go', onclick: async () => {
        try {
          const r = await call('send', { p_users: userIds, p_course: sel.value, p_message: msgIn.value, p_emails: emails.value.split(/[,\s;]+/).filter(Boolean) });
          out.textContent = r.offers ? 'Sent ' + r.offers + (r.offers === 1 ? ' offer.' : ' offers.') : 'Nothing to send: they already have it or have an offer waiting.';
          setTimeout(() => d.close(), 1200);
        } catch (e) { out.textContent = e.message; out.className = 'err'; }
      } }, 'Send'), el('button', { class: 'btn', onclick: () => d.close() }, 'Cancel')])]);
    document.body.appendChild(d); d.showModal(); d.addEventListener('close', () => d.remove());
  }

  async function ownerOffers(box, call) {
    const offers = await call('offers');
    const t = el('table', { class: 'data', 'data-testid': 'offers-table' }, [el('tr', {}, ['To', 'Course', 'Status', 'Sent', ''].map((h) => el('th', { text: h })))]);
    offers.forEach((o) => t.appendChild(el('tr', { 'data-testid': 'offer-row', 'data-status': o.status }, [
      el('td', { text: o.to_name || o.to_email }), el('td', { text: o.course_title }), el('td', { text: o.status + (o.responded_at ? ' · ' + ago(o.responded_at) : '') }), el('td', { text: ago(o.created_at) }),
      el('td', {}, o.status === 'pending' ? el('button', { class: 'btn danger', onclick: async () => { await call('withdraw', { p_offer: o.id }); render(); } }, 'Withdraw') : null)])));
    if (!offers.length) box.appendChild(el('p', { class: 'muted', text: 'No offers yet. Send one from People.' }));
    box.appendChild(el('div', { class: 'scroll-x' }, t));
  }

  async function ownerCourses(box, call) {
    const courses = await call('courses');
    if (!courses.length) box.appendChild(el('p', { class: 'muted', text: 'No courses on the hub yet. Publish one with: node scripts/publish-course.mjs <course>' }));
    courses.forEach((c) => {
      const status = el('select', {}, [['draft', 'Draft (only you)'], ['published', 'Published']].map(([v, n]) => el('option', { value: v, selected: c.status === v ? true : null }, n)));
      const vis = el('select', {}, [['private', 'Only people I send it to'], ['open', 'Everyone signed in']].map(([v, n]) => el('option', { value: v, selected: c.visibility === v ? true : null }, n)));
      const listed = el('input', { type: 'checkbox', checked: c.listed ? true : null });
      const inviteOut = el('p', { class: 'muted' });
      box.appendChild(el('article', { class: 'card', style: 'margin-bottom:16px', 'data-testid': 'owner-course-' + c.id }, [
        el('div', { class: 'row', style: 'justify-content:space-between' }, [el('h3', { style: 'margin:0', text: c.title }), el('span', { class: 'tag', text: (c.latest_version ? 'v' + c.latest_version : 'not uploaded') + ' · ' + c.status })]),
        el('div', { class: 'grid', style: 'margin-top:10px' }, [el('label', { class: 'f' }, [el('span', { text: 'Status' }), status]), el('label', { class: 'f' }, [el('span', { text: 'Who can open it' }), vis]),
          el('label', { class: 'f' }, [el('span', { text: 'Listed' }), el('span', {}, [listed, ' Show the title to everyone so they can ask for it'])])]),
        el('div', { class: 'row' }, [el('button', { class: 'btn', onclick: async () => { await call('save_course', { p_id: c.id, p_title: c.title, p_description: c.description, p_status: status.value, p_visibility: vis.value, p_listed: listed.checked }); toast('Saved.'); } }, 'Save'),
          el('button', { class: 'btn', onclick: async () => { const r = await call('invite', { p_courses: [c.id], p_message: '', p_days: 30, p_uses: null }); inviteOut.textContent = 'Invite code: ' + r.code + ' — send it with the download link. It works for 30 days.'; } }, 'Make an invite code')]),
        inviteOut,
        el('h4', { text: 'Who has it (' + c.holders.length + ')' }),
        el('table', { class: 'data' }, [el('tr', {}, ['Person', 'Progress', 'Last', 'How'].map((h) => el('th', { text: h })))].concat(c.holders.map((h) => el('tr', {}, [el('td', { text: h.display_name }), el('td', { text: h.percent + '%' }), el('td', { text: h.current_title || '' }), el('td', { text: h.via })])))),
        c.pending.length ? el('p', { class: 'muted', text: 'Waiting to accept: ' + c.pending.map((p) => p.display_name).join(', ') }) : null,
      ]));
    });
  }

  async function ownerGroups(box, call) {
    const [groups, people, courses] = await Promise.all([call('groups'), call('people'), call('courses')]);
    const name = el('input', { type: 'text', placeholder: 'e.g. ColdFusion cohort' });
    box.appendChild(el('div', { class: 'row', style: 'margin-bottom:16px' }, [name, el('button', { class: 'btn', onclick: async () => { if (!name.value.trim()) return; await call('group_save', { p_id: null, p_name: name.value }); render(); } }, 'New group')]));
    box.appendChild(el('p', { class: 'muted', text: 'Everyone in a group is offered the group’s courses — including people you add later.' }));
    groups.forEach((g) => {
      const addP = el('select', {}, [el('option', { value: '' }, 'Add a person…')].concat(people.filter((p) => p.id && p.role !== 'owner' && !g.members.some((m) => m.user_id === p.id)).map((p) => el('option', { value: p.id }, p.display_name))));
      const addC = el('select', {}, [el('option', { value: '' }, 'Add a course…')].concat(courses.filter((c) => g.courses.indexOf(c.id) < 0).map((c) => el('option', { value: c.id }, c.title))));
      box.appendChild(el('article', { class: 'card', style: 'margin-bottom:14px' }, [el('h3', { style: 'margin-top:0', text: g.name }),
        el('p', {}, ['Members: ', g.members.map((m) => m.display_name).join(', ') || 'none']),
        el('p', {}, ['Courses: ', g.courses.map((id) => courseTitle(courses, id)).join(', ') || 'none']),
        el('div', { class: 'row' }, [addP, el('button', { class: 'btn', onclick: async () => { if (!addP.value) return; const r = await call('group_members', { p_group: g.id, p_add: [addP.value], p_remove: [] }); toast('Added. ' + r.offers + ' offer(s) sent.'); render(); } }, 'Add'),
          addC, el('button', { class: 'btn', onclick: async () => { if (!addC.value) return; const r = await call('group_courses', { p_group: g.id, p_add: [addC.value], p_remove: [], p_message: '' }); toast('Added. ' + r.offers + ' offer(s) sent.'); render(); } }, 'Add')])]));
    });
  }

  async function ownerRequests(box, call) {
    const reqs = await call('requests');
    if (!reqs.length) box.appendChild(el('p', { class: 'muted', text: 'No requests. People can ask for courses you mark as listed.' }));
    reqs.forEach((r) => box.appendChild(el('div', { class: 'card', style: 'margin-bottom:10px' }, [el('b', { text: r.display_name + ' asked for ' + r.course_title }), r.message ? el('blockquote', { text: r.message }) : null,
      r.status === 'pending' ? el('div', { class: 'row' }, [el('button', { class: 'btn primary', onclick: async () => { await call('answer_request', { p_request: r.id, p_approve: true }); render(); } }, 'Approve'), el('button', { class: 'btn', onclick: async () => { await call('answer_request', { p_request: r.id, p_approve: false }); render(); } }, 'Decline')]) : el('span', { class: 'tag', text: r.status })])));
  }

  /* ---------------------------------------------------------------- seams */
  window.LanternShell = {
    version: 2, api, el, toast, on, fire, registerSettings, md, ask, measure,
    here: () => Object.assign({}, S.here),
    route: () => route(),
    render: () => render(),
    platform: () => S.platform,
    // The docked assistant: render(panel) fills the slot and it is shown.
    registerAssistant(renderFn) { const slot = $('#assistant-slot'); slot.innerHTML = ''; renderFn(slot); slot.hidden = false; },
    hideAssistant() { $('#assistant-slot').hidden = true; },
    // A mini player (music, video) docked bottom-left.
    registerMedia(renderFn) { const slot = $('#media-slot'); slot.innerHTML = ''; renderFn(slot); },
    // What the person is studying right now: course, unit, lesson, objectives, key terms.
    // A page of its own (#/<name>): render(main, route). friends.js adds #/friends.
    registerPage(name, renderFn) { pages[name] = renderFn; if (route().name === name) render(); },
    context() { const r = route(); return r.id ? api('/api/courses/' + encodeURIComponent(r.id) + '/context') : api('/api/context'); },
  };

  /* ---------------------------------------------------------------- start */
  const fitBar = () => { const b = $('.bar'); if (b) document.documentElement.style.setProperty('--shell-bar', b.offsetHeight + 'px'); };
  fitBar();
  if (window.ResizeObserver) new ResizeObserver(fitBar).observe($('.bar')); else window.addEventListener('resize', fitBar);
  window.addEventListener('hashchange', render);
  (async () => {
    await refreshPlatform();
    const rec = S.platform && S.platform.recovered;
    if (rec && stored('lantern.shell.recovered') !== rec.aside && (store('lantern.shell.recovered', rec.aside), true)) toast(el('div', {}, [el('b', { text: 'Lantern repaired itself. ' }), 'Its saved data could not be read, so it ' + (rec.from ? 'went back to the backup ' + rec.from + '.' : 'started fresh.') + ' Progress kept on your hub comes back when you sign in. The damaged file was kept, not deleted.']), { sticky: true, testid: 'recovered' });
    connectEvents();
    await render();
  })();
})();
