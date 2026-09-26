/* ===========================================================================
   server/public/shell/friends.js — Friends: your friend code, finding people,
   requests (accept, decline, ignore), your friends, and — for the owner —
   sending a friend a course.
   ---------------------------------------------------------------------------
   Adds the #/friends page through LanternShell.registerPage, keeps the badge
   on the Friends link up to date, and shows a toast for a new request or an
   accepted one. The server side is server/src/platform/friends-routes.js; the
   rules are on the hub (supabase/migrations/0002_friends.sql).
   =========================================================================== */
(function () {
  'use strict';
  const LS = window.LanternShell;
  if (!LS) return;
  const { api, el, toast } = LS;

  const F = { view: null };
  const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim());
  const ago = (s) => { if (!s) return 'not yet'; const t = Date.parse(s); if (isNaN(t)) return ''; const m = Math.round((Date.now() - t) / 60000); if (m < 2) return 'just now'; if (m < 60) return m + ' min ago'; const h = Math.round(m / 60); if (h < 48) return h + ' h ago'; return Math.round(h / 24) + ' days ago'; };
  const here = () => LS.route().name === 'friends';

  /* ---------------------------------------------------------------- badge */
  function paintBadge(n) {
    const b = document.getElementById('friends-badge');
    if (!b) return;
    b.textContent = n > 0 ? String(n) : '';
    b.hidden = !(n > 0);
    b.setAttribute('aria-label', n === 1 ? '1 new friend request' : n + ' new friend requests');
  }
  async function load(refresh) {
    try { F.view = await api('/api/hub/friends' + (refresh ? '?refresh=1' : '')); paintBadge(F.view.waiting || 0); }
    catch (e) { /* the app is restarting */ }
    return F.view;
  }

  /* --------------------------------------------------------------- toasts */
  LS.on('friend-request', (ev) => {
    const r = ev && ev.request;
    if (!r) return;
    const t = toast(el('div', { 'data-req': r.id }, [
      el('span', { class: 'chip lantern', text: 'Friend request' }), ' ',
      el('b', { text: r.from_name + ' wants to be friends.' }),
      r.message ? el('blockquote', { class: 'fr-note', text: r.message }) : null,
      el('div', { class: 'row', style: 'margin-top:8px' }, [
        el('button', { class: 'btn primary', 'data-testid': 'friend-toast-accept', onclick: () => answer(r.id, 'accept', t) }, 'Accept'),
        el('button', { class: 'btn', onclick: () => answer(r.id, 'ignore', t) }, 'Ignore'),
        el('a', { class: 'btn', href: '#/friends', onclick: () => t.remove() }, 'See it')]),
    ]), { sticky: true, testid: 'friend-toast', key: 'fr-' + r.id });
    load(false);
  });
  const dropRequestToasts = (id) => document.querySelectorAll('[data-testid=friend-toast]').forEach((x) => { if (!id || x.querySelector('[data-req="' + id + '"]')) x.remove(); });
  let justAccepted = 0;
  LS.on('friend-accepted', (ev) => {
    const x = ev && ev.friend;
    if (!x) return;
    // "You are friends now" was already said to the one who pressed Accept
    if (Date.now() - justAccepted < 15000) { load(false).then(() => { if (here()) LS.render(); }); return; }
    const owner = F.view && F.view.owner;
    toast(el('div', {}, [el('b', { text: x.display_name + ' is now your friend.' }), owner ? ' ' : null,
      owner ? el('a', { href: '#/friends', text: 'Send them a course' }) : null]), { ms: 12000, testid: 'friend-accepted-toast' });
    load(false).then(() => { if (here()) LS.render(); });
  });
  // A catalog pass (every half minute) says how many requests wait. The page
  // is drawn again only when something on it changed, and never while the
  // person is typing in it.
  const sig = (v) => v ? JSON.stringify([v.available, v.online, v.friends.map((x) => [x.id, x.online, x.current_course]), v.received.map((r) => [r.id, r.status]), v.sent.map((r) => [r.id, r.status]), v.blocked.map((b) => b.id)]) : '';
  LS.on('friends', (ev) => {
    if (ev && typeof ev.received === 'number') paintBadge(ev.received);
    const hasToast = !!document.querySelector('[data-testid=friend-toast]');
    if ((!here() && !hasToast) || busy) return;
    const was = sig(F.view);
    load(false).then(() => {
      // a request answered somewhere else (the Friends page, another computer) takes its notice with it
      const waiting = new Set(((F.view && F.view.received) || []).filter((r) => r.status === 'pending').map((r) => r.id));
      document.querySelectorAll('[data-testid=friend-toast] [data-req]').forEach((x) => { if (!waiting.has(x.dataset.req)) x.closest('.toast').remove(); });
      if (!here()) return;
      const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && document.getElementById('main').contains(document.activeElement);
      if (here() && !busy && !typing && !document.querySelector('dialog[open]') && sig(F.view) !== was) LS.render();
    });
  });
  LS.on('signed-in', () => load(true));
  LS.on('signed-out', () => { F.view = null; paintBadge(0); });

  let busy = false;
  async function answer(id, action, toastEl) {
    try {
      busy = true;
      if (action === 'accept') justAccepted = Date.now();   // its own event can arrive before the answer does
      await api('/api/hub/friends/requests/' + encodeURIComponent(id) + '/' + action, { method: 'POST', body: {} });
      if (toastEl) toastEl.remove();
      dropRequestToasts(id);
      toast(action === 'accept' ? 'You are friends now.' : action === 'decline' ? 'Declined. They will not be told why.' : action === 'cancel' ? 'Request cancelled.' : 'Set aside. It stays under Friends → Set aside, and you can still accept it later.');
      await load(false);
    } catch (e) { toast(e.message, { sticky: true }); }
    finally { busy = false; }
    if (here()) LS.render();
  }

  /* ----------------------------------------------------------------- page */
  async function renderFriends(main) {
    main.innerHTML = '';
    main.appendChild(el('h1', { text: 'Friends' }));
    main.appendChild(el('p', { class: 'lede', text: 'Add the people you learn with. Friends can see when you are online and what you are studying.' }));
    const v = await load(true);
    if (!v || !v.signedIn) {
      main.appendChild(el('div', { class: 'card', 'data-testid': 'friends-signin' }, [el('h2', { style: 'margin-top:0', text: 'Sign in first' }),
        el('p', { text: 'Friends live on your hub, so you need to be signed in to one.' }),
        el('a', { class: 'btn primary', href: '#/settings/account' }, 'Account & hub')]));
      return;
    }
    if (!v.available) {
      main.appendChild(el('div', { class: 'card', 'data-testid': 'friends-unavailable' }, [el('h2', { style: 'margin-top:0', text: 'Friends are not switched on for this hub yet' }),
        el('p', { text: v.owner ? 'Your hub was set up before friends existed. In Supabase, open SQL Editor → New query, paste supabase/migrations/0002_friends.sql from the Lantern download and click Run. Then come back here.' : 'Ask the person who runs your hub to add the friends update (0002_friends.sql).' })]));
      return;
    }
    if (!v.online) main.appendChild(el('p', { class: 'muted', 'data-testid': 'friends-offline', text: 'You are offline. This is the list from the last time Lantern reached the hub; changes need the hub.' }));

    const grid = el('div', { class: 'fr-grid' });
    main.appendChild(grid);
    grid.appendChild(codeCard(v));
    grid.appendChild(findCard(v));
    if (v.received.length) grid.appendChild(receivedCard(v));
    grid.appendChild(friendsCard(v));
    if (v.sent.length) grid.appendChild(sentCard(v));
    if (v.owner) grid.appendChild(await hubPeopleCard(v));
    if (v.blocked.length) grid.appendChild(blockedCard(v));
  }

  function codeCard(v) {
    const code = (v.me && v.me.friend_code) || '—';
    const byName = el('input', { type: 'checkbox', checked: v.me && v.me.findable_by_name ? true : null, onchange: async () => {
      try { await api('/api/hub/friends/findable', { method: 'POST', body: { byName: byName.checked } }); toast(byName.checked ? 'People can now find you by your name.' : 'Only your code or email finds you now.'); }
      catch (e) { toast(e.message); byName.checked = !byName.checked; }
    } });
    return el('section', { class: 'card fr-code' }, [
      el('h2', { text: 'Your friend code' }),
      el('div', { class: 'row' }, [el('span', { class: 'fr-codetext', 'data-testid': 'friends-code', text: code }),
        el('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(code); toast('Copied ' + code + '.'); } catch (e) { toast('Your code is ' + code + '.'); } } }, 'Copy')]),
      el('p', { class: 'muted', text: 'Share it (or your email address) with a friend. They type it under “Add a friend”.' }),
      el('label', { class: 'fr-check' }, [byName, ' Let people find me by my name too']),
    ]);
  }

  function findCard(v) {
    const q = el('input', { type: 'text', placeholder: 'A friend code (LNT-7K3Q), an email address' + (v.owner ? ' or a name' : ''), 'aria-label': 'Friend code, email or name', 'data-testid': 'find-input' });
    const note = el('input', { type: 'text', maxlength: '300', placeholder: 'A short note (optional)', 'aria-label': 'A note with your request' });
    const out = el('div', { class: 'fr-results', 'aria-live': 'polite' });
    const go = async () => {
      const text = q.value.trim();
      out.innerHTML = '';
      if (text.length < 2) { out.appendChild(el('p', { class: 'muted', text: 'Type a friend code or an email address.' })); return; }
      out.appendChild(el('p', { class: 'muted', text: 'Looking…' }));
      let found = [];
      try { found = await api('/api/hub/friends/find', { method: 'POST', body: { query: text } }); }
      catch (e) { out.innerHTML = ''; out.appendChild(el('p', { class: 'err', text: e.message })); return; }
      out.innerHTML = '';
      found.forEach((p) => out.appendChild(personRow(p, v, note)));
      if (!found.length) {
        if (isEmail(text)) {
          out.appendChild(el('div', { class: 'fr-row' }, [el('div', {}, [el('b', { text: text }), el('div', { class: 'muted', text: 'Nobody with this email uses Lantern yet. Send a request anyway: it waits for them and shows up when they sign up (in Lantern, or in Dayspring’s “Connect to Lantern”).' })]),
            el('button', { class: 'btn primary', 'data-testid': 'add-friend-email', onclick: (e) => sendRequest(text, note.value, e.target) }, 'Send a request')]));
        } else out.appendChild(el('p', { class: 'muted', 'data-testid': 'find-none', text: 'Nobody found. Check the code, or try their email address.' }));
      }
    };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return el('section', { class: 'card' }, [el('h2', { text: 'Add a friend' }),
      el('div', { class: 'row' }, [q, el('button', { class: 'btn primary', 'data-testid': 'find-go', onclick: go }, 'Find')]),
      note, out]);
  }

  function personRow(p, v, note) {
    const actions = {
      none: () => el('button', { class: 'btn primary', 'data-testid': 'add-friend', onclick: (e) => sendRequest(p.id, note ? note.value : '', e.target) }, 'Add friend'),
      sent: () => el('span', { class: 'tag', text: 'Request sent' }),
      received: () => el('button', { class: 'btn primary', onclick: () => { const r = v.received.find((x) => x.from === p.id); if (r) answer(r.id, 'accept'); } }, 'Accept their request'),
      friend: () => el('span', { class: 'tag', text: 'Friends ✓' }),
      blocked: () => el('span', { class: 'tag', text: 'Blocked' }),
      you: () => el('span', { class: 'tag', text: 'You' }),
    };
    return el('div', { class: 'fr-row', 'data-testid': 'find-result', 'data-relation': p.relation }, [
      el('div', {}, [el('b', { text: p.display_name }), el('div', { class: 'muted', text: [p.friend_code, p.email].filter(Boolean).join(' · ') })]),
      (actions[p.relation] || actions.none)()]);
  }

  async function sendRequest(to, message, btn) {
    if (btn) btn.disabled = true;
    try {
      const r = await api('/api/hub/friends/request', { method: 'POST', body: { to, message } });
      toast(r.status === 'friend' ? (r.accepted_theirs ? 'They had already asked you, so you are friends now.' : 'You are already friends.')
        : r.waiting_for_signup ? 'Sent. It waits for them until they sign up.' : 'Friend request sent. You will see here when they answer.');
      await load(false);
      LS.render();
    } catch (e) { toast(e.message, { sticky: true }); if (btn) btn.disabled = false; }
  }

  function receivedCard(v) {
    const waiting = v.received.filter((r) => r.status === 'pending');
    const ignored = v.received.filter((r) => r.status === 'ignored');
    const row = (r, withIgnore) => el('div', { class: 'fr-row', 'data-testid': 'fr-received', 'data-status': r.status, 'data-from': r.from_name }, [
      el('div', {}, [el('b', { text: r.from_name }), r.from_role === 'owner' ? el('span', { class: 'tag', style: 'margin-left:6px', text: 'Runs this hub' }) : null,
        el('div', { class: 'muted', text: (r.from_code || '') + ' · ' + ago(r.created_at) }), r.message ? el('blockquote', { class: 'fr-note', text: r.message }) : null]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn primary', 'data-testid': 'fr-accept', onclick: () => answer(r.id, 'accept') }, 'Accept'),
        el('button', { class: 'btn', 'data-testid': 'fr-decline', onclick: () => answer(r.id, 'decline') }, 'Decline'),
        withIgnore ? el('button', { class: 'btn', 'data-testid': 'fr-ignore', onclick: () => answer(r.id, 'ignore') }, 'Ignore') : null])]);
    const box = el('section', { class: 'card fr-requests', 'data-testid': 'fr-requests' }, [el('h2', { text: 'Friend requests' })]);
    if (waiting.length) waiting.forEach((r) => box.appendChild(row(r, true)));
    else box.appendChild(el('p', { class: 'muted', text: 'No new requests.' }));
    if (ignored.length) {
      const d = el('details', { class: 'fr-ignored', 'data-testid': 'fr-ignored' }, [el('summary', { text: 'Set aside (' + ignored.length + ')' }),
        el('p', { class: 'muted', text: 'Requests you ignored. They still wait for you; the sender just sees “waiting”.' })]);
      ignored.forEach((r) => d.appendChild(row(r, false)));
      box.appendChild(d);
    }
    return box;
  }

  function friendsCard(v) {
    const box = el('section', { class: 'card', 'data-testid': 'friends-list' }, [el('h2', { text: 'Your friends' + (v.friends.length ? ' (' + v.friends.length + ')' : '') })]);
    if (!v.friends.length) {
      box.appendChild(el('div', { class: 'fr-empty', 'data-testid': 'friends-empty' }, [
        el('p', { text: 'No friends yet.' }),
        el('ol', {}, [el('li', { text: 'Share your friend code (above) with someone who has Lantern, or type theirs under “Add a friend”.' }),
          el('li', { text: 'They accept your request (or you accept theirs).' }),
          el('li', { text: v.owner ? 'Then you can send them a course from here.' : 'Then you can see when each other are online and studying.' })])]));
      return box;
    }
    v.friends.forEach((x) => {
      box.appendChild(el('div', { class: 'fr-row', 'data-testid': 'friend-row', 'data-name': x.display_name }, [
        el('div', {}, [el('b', { text: x.display_name }), x.role === 'owner' ? el('span', { class: 'tag', style: 'margin-left:6px', text: 'Runs this hub' }) : null,
          el('div', { class: 'muted' }, [el('span', { class: 'dot ' + (x.online ? 'on' : '') }), x.online ? ' Online' + (x.current_course_title ? ' · studying ' + x.current_course_title : '') : ' Last seen ' + ago(x.last_seen)])]),
        el('div', { class: 'row' }, [
          v.owner && x.role !== 'owner' ? el('button', { class: 'btn primary', 'data-testid': 'friend-send-course', onclick: () => sendCourseDialog(x) }, 'Send a course') : null,
          el('button', { class: 'btn', onclick: async () => { if (!(await confirmIn('Remove ' + x.display_name + ' from your friends?'))) return; await act(x.id, 'remove', 'Removed.'); } }, 'Remove'),
          el('button', { class: 'btn danger', onclick: async () => { if (!(await confirmIn('Block ' + x.display_name + '? They will not be able to send you requests or find you.'))) return; await act(x.id, 'block', 'Blocked.'); } }, 'Block')])]));
    });
    return box;
  }

  function sentCard(v) {
    const box = el('section', { class: 'card', 'data-testid': 'fr-sent' }, [el('h2', { text: 'Requests you sent' })]);
    const label = { pending: 'Waiting', accepted: 'Accepted', declined: 'Not accepted' };
    v.sent.forEach((r) => box.appendChild(el('div', { class: 'fr-row', 'data-testid': 'fr-sent-row', 'data-status': r.status }, [
      el('div', {}, [el('b', { text: r.to_name }), el('div', { class: 'muted', text: (label[r.status] || r.status) + (r.to_email ? ' · waiting for them to sign up' : '') + ' · sent ' + ago(r.created_at) })]),
      r.status === 'pending' ? el('button', { class: 'btn', onclick: () => answer(r.id, 'cancel') }, 'Cancel') : null])));
    return box;
  }

  function blockedCard(v) {
    const box = el('section', { class: 'card' }, [el('h2', { text: 'Blocked' })]);
    v.blocked.forEach((b) => box.appendChild(el('div', { class: 'fr-row' }, [el('b', { text: b.display_name }), el('button', { class: 'btn', onclick: () => act(b.id, 'unblock', 'Unblocked.') }, 'Unblock')])));
    return box;
  }

  // The owner: everyone who has Lantern on this hub, with "Add friend".
  async function hubPeopleCard(v) {
    const box = el('section', { class: 'card', 'data-testid': 'fr-hub-people' }, [el('h2', { text: 'People on your hub' }),
      el('p', { class: 'muted', text: 'Everyone who has signed up to your hub in Lantern. Add them as friends, then send them courses.' })]);
    let people = [];
    try { people = await api('/api/hub/owner/people', { method: 'POST', body: {} }); }
    catch (e) { box.appendChild(el('p', { class: 'muted', text: v.online ? e.message : 'Shown when you are online.' })); return box; }
    const others = people.filter((p) => p.id && p.role !== 'owner');
    if (!others.length) box.appendChild(el('p', { class: 'muted', 'data-testid': 'fr-hub-empty', text: 'Nobody else yet. When someone installs Lantern and signs up to your hub, they appear here.' }));
    others.forEach((p) => box.appendChild(el('div', { class: 'fr-row', 'data-testid': 'hub-person', 'data-email': p.email || '', 'data-relation': p.relation || 'none' }, [
      el('div', {}, [el('b', { text: p.display_name }), el('div', { class: 'muted' }, [el('span', { class: 'dot ' + (p.online ? 'on' : '') }), (p.online ? ' Online' : ' ' + ago(p.last_seen)) + (p.app_version ? ' · Lantern ' + p.app_version : '') + (p.email ? ' · ' + p.email : '')])]),
      personRow({ id: p.id, display_name: p.display_name, relation: p.relation || 'none' }, v, null).lastChild])));
    return box;
  }

  async function act(userId, action, done) {
    try { await api('/api/hub/friends/' + encodeURIComponent(userId) + '/' + action, { method: 'POST', body: {} }); toast(done); await load(false); LS.render(); }
    catch (e) { toast(e.message, { sticky: true }); }
  }

  // An in-page yes/no (native confirm() does nothing in some embedded windows).
  function confirmIn(text) {
    return new Promise((resolve) => {
      const d = el('dialog', { class: 'fr-dialog' }, [el('p', { text }), el('div', { class: 'row' }, [
        el('button', { class: 'btn primary', onclick: () => { d.close(); resolve(true); } }, 'Yes'),
        el('button', { class: 'btn', onclick: () => { d.close(); resolve(false); } }, 'Cancel')])]);
      d.addEventListener('cancel', () => resolve(false));
      d.addEventListener('close', () => d.remove());
      document.body.appendChild(d); d.showModal();
    });
  }

  // The owner sends a friend a course: an offer they accept in their Lantern.
  async function sendCourseDialog(friend) {
    let courses = [];
    try { courses = await api('/api/hub/owner/courses', { method: 'POST', body: {} }); } catch (e) { toast(e.message); return; }
    if (!courses.length) { toast('There are no courses on your hub yet. Publish one first: node scripts/publish-course.mjs <course> --publish'); return; }
    const sel = el('select', { 'data-testid': 'friend-course-select', 'aria-label': 'Course' }, courses.map((c) => el('option', { value: c.id }, c.title + (c.status === 'draft' ? ' (draft — publish it first)' : ''))));
    const msg = el('textarea', { maxlength: '500', placeholder: 'A short note (optional)', 'data-testid': 'friend-course-message' });
    const out = el('p', { class: 'muted' });
    const d = el('dialog', { class: 'fr-dialog' }, [el('h2', { text: 'Send ' + friend.display_name + ' a course' }),
      el('p', { class: 'muted', text: 'They get an invitation in Lantern (and in Dayspring, if they use it) and choose to accept it. If they do not have Lantern yet, the invitation waits for them.' }),
      el('label', { class: 'f' }, [el('span', { text: 'Course' }), sel]), el('label', { class: 'f' }, [el('span', { text: 'Message' }), msg]), out,
      el('div', { class: 'row' }, [el('button', { class: 'btn primary', 'data-testid': 'friend-send-go', onclick: async (e) => {
        e.target.disabled = true;
        try {
          const r = await api('/api/hub/owner/send', { method: 'POST', body: { p_users: [friend.id], p_course: sel.value, p_message: msg.value, p_emails: [] } });
          out.textContent = r.offers ? 'Sent. ' + friend.display_name + ' will see it in Lantern.' : friend.display_name + ' already has this course or an invitation for it.';
          setTimeout(() => d.close(), 1400);
        } catch (err) { out.textContent = err.message; out.className = 'err'; e.target.disabled = false; }
      } }, 'Send'), el('button', { class: 'btn', onclick: () => d.close() }, 'Cancel')])]);
    document.body.appendChild(d); d.showModal(); d.addEventListener('close', () => d.remove());
  }

  LS.registerPage('friends', renderFriends);
  load(false);
  setInterval(() => { if (!here()) load(false); }, 60000);
})();
