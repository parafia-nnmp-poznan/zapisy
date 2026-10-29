/*
 * © 2026 Tomasz Sobkowiak. Wszelkie prawa zastrzeżone. Licencja: patrz plik LICENSE.
 * Parafia Nawiedzenia NMP w Poznaniu ma licencję na używanie; inne użycie wymaga zgody autora.
 */
/*
 * Zapisy na posługi liturgiczne – Parafia Nawiedzenia NMP w Poznaniu: front end (GitHub Pages).
 * Talks to the Apps Script web app (see config.js) using JSON over POST with a text/plain body.
 * All user-supplied text is inserted with textContent (never innerHTML).
 * UI texts are in Polish on purpose; identifiers are in English.
 */
(function () {
  'use strict';

  var APP_VERSION = '4.1';
  var CONFIG = window.ZAPISY_CONFIG || {};
  var POLL_MS = (CONFIG.POLL_SECONDS || 60) * 1000;
  var TIMEOUT_MS = (CONFIG.REQUEST_TIMEOUT_SECONDS || 40) * 1000;
  var RETENTION_DAYS = CONFIG.RETENTION_DAYS || 30;   // only for the texts; the real clean-up runs in the Apps Script
  var FEEDBACK_MAX = 1000;

  var MONTHS = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
  var MONTHS_SHORT = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];

  // ------------------------------------------------------------ small helpers
  var $ = function (id) { return document.getElementById(id); };

  var store = {   // localStorage that never throws (private mode, blocked storage)
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function spinner(extra) { var s = el('span', 'spinner' + (extra ? ' ' + extra : '')); s.setAttribute('aria-hidden', 'true'); return s; }

  function normalize(s) {   // case-, accent- and "ł"-insensitive text for searching
    return String(s || '').toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  function pad2(n) { return ('0' + n).slice(-2); }
  function isoOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayIso() { return isoOf(new Date()); }
  function tomorrowIso() { var d = new Date(); d.setDate(d.getDate() + 1); return isoOf(d); }
  function parseIso(iso) { var p = iso.split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
  function formatDate(iso) { var p = iso.split('-'); return p[2] + '.' + p[1]; }
  function clock(ts) { var d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function capitalize(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  function applyRetention(root) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-retention]'), function (n) { n.textContent = String(RETENTION_DAYS); });
  }

  function randomId() {
    var a = new Uint8Array(12), i;
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
    else for (i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(a, function (b) { return pad2(b.toString(16)); }).join('');
  }

  // ------------------------------------------------------------ state
  var pin = store.get('pin', '');                 // sacristy PIN; empty = normal visitor
  var myIds = [];                                 // ids of sign-ups made in this browser
  try { myIds = JSON.parse(store.get('myIds', '[]')); if (!Array.isArray(myIds)) myIds = []; } catch (e) { myIds = []; }
  var clientIdValue = '';                         // random id of this browser; only used to rate-limit problem reports
  var data = null;                                // last payload: { masses: [...], sacristy: bool }
  var updatedAt = 0;                              // when `data` was fetched (ms)
  var fromCache = false;                          // `data` came from localStorage, not from the server
  var requestSeq = 0;                             // to ignore out-of-order responses
  var pending = 0;                                // number of requests in flight (drives the progress bar)
  var dialogOpen = false;
  var dialogBusy = false;
  var lastFocus = null;                           // element to give the focus back to when a dialog closes
  var filters = { date: '', time: '', person: '', free: false };

  function saveMyIds() { store.set('myIds', JSON.stringify(myIds)); }

  // The person's profile (first name, last name, phone) lives on this device. name + phone identify the person's
  // sign-ups on every device, so "Moje zapisy" works anywhere after entering the same data.
  function normPhone(v) {
    var d = String(v || '').replace(/\D/g, '');
    if (d.length === 13 && d.indexOf('0048') === 0) d = d.slice(4);
    else if (d.length === 11 && d.indexOf('48') === 0) d = d.slice(2);
    return d.length === 9 ? d : '';
  }
  function fmtPhone(d) { return String(d).replace(/^(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3'); }
  function profileName(p) { return p.first + ' ' + p.last; }
  function loadProfile() {
    try {
      var p = JSON.parse(store.get('profile', 'null'));
      if (p && p.first && p.last && normPhone(p.phone)) return { first: p.first, last: p.last, phone: normPhone(p.phone) };
    } catch (e) { /* fall through */ }
    return null;
  }
  var profile = loadProfile();
  function saveProfile(p) { profile = p; store.set('profile', JSON.stringify(p)); }
  function ownerPayload() { return profile ? { name: profileName(profile), phone: profile.phone } : null; }

  function clientId() {
    if (clientIdValue) return clientIdValue;
    var v = store.get('clientId', '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(v)) { v = randomId(); store.set('clientId', v); }
    clientIdValue = v;
    return v;
  }

  // ------------------------------------------------------------ API
  function configured() { return typeof CONFIG.API_URL === 'string' && /^https:\/\//.test(CONFIG.API_URL); }

  function setPending(delta) {
    pending = Math.max(0, pending + delta);
    $('progress').hidden = pending === 0;
  }

  function userError(message) { var e = new Error(message); e.user = true; return e; }

  /** POST { action, ...payload } and resolve with `data`; reject with an Error carrying a Polish message. */
  function api(action, payload) {
    if (!configured()) return Promise.reject(userError('Aplikacja nie jest skonfigurowana (brak adresu API w pliku config.js).'));
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, TIMEOUT_MS) : null;
    var body = JSON.stringify(Object.assign({ action: action }, payload || {}));
    setPending(1);
    return fetch(CONFIG.API_URL, {
      method: 'POST', credentials: 'omit', redirect: 'follow', cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body,
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      return res.text();
    }).then(function (text) {
      var json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      if (!json) throw userError('Serwer zwrócił nieoczekiwaną odpowiedź. Spróbuj ponownie za chwilę.');
      if (!json.ok) throw userError(json.error || 'Wystąpił błąd serwera.');
      return json.data;
    }).then(function (result) {
      clearTimeout(timer); setPending(-1); return result;
    }, function (err) {
      clearTimeout(timer); setPending(-1);
      if (err && err.user) throw err;   // already a readable message
      if (err && err.name === 'AbortError') throw userError('Serwer odpowiada zbyt wolno. Spróbuj ponownie.');
      throw userError('Brak połączenia z serwerem. Sprawdź internet i spróbuj ponownie.');
    });
  }

  // ------------------------------------------------------------ banner and toast
  function showBanner(text, warn, withRetry) {
    var b = $('banner');
    b.textContent = '';
    if (!text) { b.hidden = true; return; }
    b.className = 'banner' + (warn ? ' warn' : '');
    b.appendChild(el('div', '', text));
    if (withRetry) {
      var retry = el('button', 'btn small', 'Spróbuj ponownie');
      retry.type = 'button';
      retry.onclick = function () { loadData({ fresh: true }); };
      b.appendChild(retry);
    }
    b.hidden = false;
  }

  var toastTimer = null;
  function toast(text, isError) {
    var t = $('toast');
    t.textContent = text;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isError ? 6000 : 3500);
  }

  // ------------------------------------------------------------ loading data
  function cacheKey() { return 'listCache'; }

  function saveCache() {
    if (!data || data.sacristy) return;   // never keep phone numbers on the device
    store.set(cacheKey(), JSON.stringify({ at: updatedAt, data: data }));
  }

  function loadCache() {
    try {
      var c = JSON.parse(store.get(cacheKey(), 'null'));
      if (c && c.data && Array.isArray(c.data.masses)) {
        var today = todayIso();
        c.data.masses = c.data.masses.filter(function (m) { return m.date >= today; });
        return c;
      }
    } catch (e) {}
    return null;
  }

  /** opts.fresh: bypass the server cache (after a change / manual refresh). opts.manual: show "Odświeżam…" on the button. */
  function loadData(opts) {
    opts = opts || {};
    var seq = ++requestSeq;
    var firstLoad = !data;
    if (firstLoad) renderLoading();
    var refreshBtn = $('btnRefresh');
    if (opts.manual) { refreshBtn.disabled = true; refreshBtn.textContent = ''; refreshBtn.appendChild(spinner()); refreshBtn.appendChild(document.createTextNode('Odświeżam…')); }

    return api('getData', { pin: pin, myIds: myIds, fresh: !!opts.fresh, owner: ownerPayload() }).then(function (result) {
      if (seq !== requestSeq) return;   // a newer request has been started; ignore this one
      if (result && result.error === 'PIN') {
        pin = ''; store.del('pin');
        showBanner('Zapisany PIN zakrystii jest nieprawidłowy. Tryb zakrystii został wyłączony.', true);
        return loadData({ fresh: true });
      }
      var visible = {};   // forget ids of sign-ups that no longer exist
      result.masses.forEach(function (m) { m.slots.forEach(function (s) { if (s.mine && s.id) visible[s.id] = true; }); });
      myIds = myIds.filter(function (id) { return visible[id]; });
      saveMyIds();

      data = result; updatedAt = Date.now(); fromCache = false;
      saveCache();
      showBanner('');
      render();
    }, function (err) {
      if (seq !== requestSeq) return;
      if (data) {
        fromCache = false;   // the "updating…" notice is over; show why it failed instead
        render();
        showBanner(err.message + ' Pokazuję dane z godz. ' + clock(updatedAt) + '.', true, true);
      } else {
        renderError(err.message);
      }
    }).then(function () {
      if (opts.manual) { refreshBtn.disabled = false; refreshBtn.textContent = 'Odśwież'; }
    });
  }

  // ------------------------------------------------------------ rendering
  function renderLoading() {
    var list = $('list');
    list.textContent = '';
    var box = el('div', 'loading');
    box.appendChild(spinner('big'));
    box.appendChild(el('div', '', 'Ładowanie listy Mszy…'));
    box.appendChild(el('div', 'muted', 'Za pierwszym razem może to potrwać kilka sekund.'));
    list.appendChild(box);
    $('count').textContent = '';
  }

  function renderError(message) {
    var list = $('list');
    list.textContent = '';
    var box = el('div', 'empty');
    box.appendChild(el('p', '', message));
    var retry = el('button', 'btn primary', 'Spróbuj ponownie');
    retry.type = 'button';
    retry.onclick = function () { loadData({ fresh: true }); };
    box.appendChild(retry);
    list.appendChild(box);
    $('count').textContent = '';
  }

  /** Rebuilds a <select> only when its option set changed (so an open dropdown is not disturbed). */
  function fillSelect(select, firstLabel, options, current) {
    var signature = options.map(function (o) { return o.value + '=' + o.label; }).join('|');
    if (select.getAttribute('data-sig') !== signature) {
      select.textContent = '';
      var all = el('option', '', firstLabel); all.value = ''; select.appendChild(all);
      options.forEach(function (o) { var opt = el('option', '', o.label); opt.value = o.value; select.appendChild(opt); });
      select.setAttribute('data-sig', signature);
    }
    var valid = options.some(function (o) { return o.value === current; });
    select.value = valid ? current : '';
    return valid ? current : '';
  }

  function updateFilterOptions() {
    var dates = [], times = [], seenD = {}, seenT = {};
    data.masses.forEach(function (m) {
      if (!seenD[m.date]) { seenD[m.date] = true; dates.push({ value: m.date, label: capitalize(m.weekday) + ' ' + formatDate(m.date) }); }
      if (!seenT[m.time]) { seenT[m.time] = true; times.push({ value: m.time, label: m.time }); }
    });
    times.sort(function (a, b) { return a.value < b.value ? -1 : 1; });
    filters.date = fillSelect($('fDate'), 'Wszystkie', dates, filters.date);
    filters.time = fillSelect($('fTime'), 'Wszystkie', times, filters.time);
  }

  function filtersActive() { return !!(filters.date || filters.time || filters.person.trim() || filters.free); }

  function updateFilterUi() {
    var hidden = (filters.date ? 1 : 0) + (filters.time ? 1 : 0) + (filters.free ? 1 : 0);   // filters inside the collapsible panel
    var badge = $('filterBadge');
    badge.hidden = !hidden;
    badge.textContent = String(hidden);
    $('btnClear').hidden = !filtersActive();
  }

  function renderMode(sacristy) {
    var m = $('mode');
    m.textContent = '';
    if (sacristy) {
      m.appendChild(el('span', 'pill-mode', 'Tryb zakrystii'));
      m.appendChild(document.createTextNode('możesz dopisywać, edytować i usuwać wszystkie wpisy.'));
    } else {
      m.textContent = 'Wybierz wolne miejsce i naciśnij „Zapisz się”.';
    }
  }

  function render() {
    var sacristy = !!data.sacristy;
    document.body.classList.toggle('sacristy', sacristy);
    renderMode(sacristy);
    $('btnProfile').hidden = sacristy;
    $('btnMode').textContent = sacristy ? 'Wyłącz tryb zakrystii' : 'Tryb zakrystii';
    if (fromCache) showBanner('Pokazuję dane zapisane w urządzeniu z godz. ' + clock(updatedAt) + '. Trwa aktualizacja…', true);

    updateFilterOptions();
    updateFilterUi();

    var needle = normalize(filters.person.trim());
    var shown = 0;
    var groups = [], current = null;

    data.masses.forEach(function (mass) {
      if (filters.date && mass.date !== filters.date) return;
      if (filters.time && mass.time !== filters.time) return;
      var slots = mass.slots.filter(function (slot) {
        if (filters.free && slot.taken) return false;
        if (needle && !(slot.taken && normalize(slot.name).indexOf(needle) >= 0)) return false;
        return true;
      });
      if (!slots.length) return;
      if (!current || current.date !== mass.date) { current = { date: mass.date, weekday: mass.weekday, items: [] }; groups.push(current); }
      current.items.push({ mass: mass, slots: slots });
      shown++;
    });

    var list = $('list');
    list.textContent = '';
    if (!sacristy) {
      var notice = renderOtherPhoneNotice(); if (notice) list.appendChild(notice);
      var mineBox = renderMine() || renderProfilePrompt(); if (mineBox) list.appendChild(mineBox);
    }
    groups.forEach(function (g) { list.appendChild(renderDay(g, sacristy, !!needle)); });
    if (!shown) {
      list.appendChild(el('p', 'empty', data.masses.length ? 'Brak wyników dla wybranych filtrów.' : 'Brak terminów. Koordynator musi wygenerować terminy w arkuszu.'));
    }
    $('count').textContent = data.masses.length ? 'Msze: ' + shown + ' z ' + data.masses.length : '';
  }

  /** Shown while there is no profile on this device: the sign-ups of this person cannot be recognised yet. */
  function renderProfilePrompt() {
    if (profile) return null;
    var box = el('section', 'mine prompt-box');
    box.appendChild(el('h2', '', 'Zobacz swoje zapisy'));
    box.appendChild(el('p', 'prompt-text', 'Podaj imię, nazwisko i numer telefonu, a zobaczysz swoje zapisy zrobione na dowolnym urządzeniu i będziesz mógł(-ła) się z nich wypisać.'));
    var b = el('button', 'btn primary', 'Podaj swoje dane'); b.type = 'button';
    b.onclick = function () { openProfile(); };
    box.appendChild(b);
    return box;
  }

  /** Same name, another phone number: most likely a typo in one of the numbers. */
  function renderOtherPhoneNotice() {
    var n = data && data.sameNameOtherPhone;
    if (!profile || !n) return null;
    var tag = profileName(profile) + '|' + n;
    if (store.get('hideOtherPhone', '') === tag) return null;
    var box = el('section', 'notice');
    box.setAttribute('role', 'status');
    box.appendChild(el('p', '', 'Na imię i nazwisko ' + profileName(profile) + ' są na liście jeszcze zapisy (' + n + ') z innym numerem telefonu niż ' + fmtPhone(profile.phone) + '. Jeśli to Twoje zapisy, ktoś mógł pomylić numer. Popraw numer w „Moje dane", a zapisy się połączą.'));
    var acts = el('div', 'notice-actions');
    var fix = el('button', 'btn small primary', 'Popraw numer'); fix.type = 'button';
    fix.onclick = function () { openProfile(); };
    var no = el('button', 'btn small', 'To nie moje zapisy'); no.type = 'button';
    no.onclick = function () { store.set('hideOtherPhone', tag); render(); };
    acts.appendChild(fix); acts.appendChild(no); box.appendChild(acts);
    return box;
  }

  /** "Moje zapisy": quick overview of this device's own sign-ups, independent of the filters. */
  function renderMine() {
    var rows = [];
    data.masses.forEach(function (mass) {
      mass.slots.forEach(function (slot) { if (slot.taken && slot.mine && slot.id) rows.push({ mass: mass, slot: slot }); });
    });
    if (!rows.length) return null;
    var box = el('section', 'mine');
    box.setAttribute('aria-labelledby', 'mineTitle');
    var title = el('h2', '', 'Moje zapisy');
    title.id = 'mineTitle';
    title.appendChild(el('span', 'mine-count', String(rows.length)));
    box.appendChild(title);
    var ul = el('ul', 'mine-list');
    rows.forEach(function (r) {
      var li = el('li', 'mine-row');
      var info = el('div', 'mine-info');
      info.appendChild(el('span', 'mine-when', capitalize(r.mass.weekday) + ' ' + formatDate(r.mass.date) + ', godz. ' + r.mass.time));
      info.appendChild(el('span', 'mine-what', r.slot.role + ' · ' + r.slot.name));
      li.appendChild(info);
      var show = el('button', 'btn small', 'Pokaż'); show.type = 'button';
      show.setAttribute('aria-label', 'Pokaż na liście: ' + r.slot.role + ', ' + r.mass.weekday + ' ' + formatDate(r.mass.date) + ' ' + r.mass.time);
      show.onclick = function () { jumpToMass(r.mass.key); };
      var leave = el('button', 'btn small danger', 'Wypisz mnie'); leave.type = 'button';
      leave.setAttribute('aria-label', 'Wypisz mnie: ' + r.slot.role + ', ' + r.mass.weekday + ' ' + formatDate(r.mass.date) + ' ' + r.mass.time);
      leave.onclick = function () { openRemove(r.mass, r.slot, false); };
      var acts = el('div', 'mine-actions'); acts.appendChild(show); acts.appendChild(leave);
      li.appendChild(acts);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    if (profile) {
      var who = el('p', 'mine-who');
      who.appendChild(el('span', '', profileName(profile) + ' · tel. ' + fmtPhone(profile.phone)));
      var change = el('button', 'linkbtn', 'Zmień dane'); change.type = 'button';
      change.onclick = function () { openProfile(); };
      who.appendChild(change);
      box.appendChild(who);
    }
    return box;
  }

  function jumpToMass(key) {
    if (filtersActive()) {
      filters = { date: '', time: '', person: '', free: false };
      $('fPerson').value = ''; $('fFree').checked = false;
      render();
    }
    var cards = document.querySelectorAll('.card[data-key]');
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-key') !== key) continue;
      var card = cards[i];
      var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      card.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
      card.classList.add('flash');
      setTimeout(function () { card.classList.remove('flash'); }, 1800);
      return;
    }
  }

  function renderDay(group, sacristy, highlight) {
    var d = parseIso(group.date);
    var section = el('div', 'day');
    section.setAttribute('role', 'group');
    section.setAttribute('data-wd', String(d.getDay()));
    var headingId = 'day-' + group.date;
    section.setAttribute('aria-labelledby', headingId);

    var head = el('div', 'day-head');
    var badge = el('div', 'day-badge');
    badge.setAttribute('aria-hidden', 'true');
    badge.appendChild(el('span', 'day-num', String(d.getDate())));
    badge.appendChild(el('span', 'day-mon', MONTHS_SHORT[d.getMonth()]));
    var titles = el('div', 'day-title');
    var h2 = el('h2', '', capitalize(group.weekday));
    h2.id = headingId;
    titles.appendChild(h2);
    titles.appendChild(el('div', 'day-date', d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear()));
    head.appendChild(badge);
    head.appendChild(titles);
    if (group.date === todayIso()) head.appendChild(el('span', 'day-tag', 'Dziś'));
    else if (group.date === tomorrowIso()) head.appendChild(el('span', 'day-tag', 'Jutro'));
    section.appendChild(head);

    var grid = el('div', 'day-grid');
    group.items.forEach(function (item) { grid.appendChild(renderMass(item.mass, item.slots, sacristy, highlight)); });
    section.appendChild(grid);
    return section;
  }

  /** The role this visitor already holds on the mass (matched by name, like the server does), or ''. */
  function roleOfVisitor(mass) {
    var mine = normalize(profile ? profileName(profile) : '').replace(/[^a-z0-9]/g, '');
    for (var i = 0; i < mass.slots.length; i++) {
      var sl = mass.slots[i];
      if (!sl.taken) continue;
      if (sl.mine || (mine && normalize(sl.name).replace(/[^a-z0-9]/g, '') === mine)) return sl.role;
    }
    return '';
  }

  // Sign-ups close shortly before a mass (the server enforces it; the sacristy is exempt). The server's clock is used, not the phone's.
  function signupClosed(mass) {
    if (!mass.closesAt) return !!mass.closed;
    var skew = (data && data.now) ? data.now - updatedAt : 0;
    return Date.now() + skew >= mass.closesAt;
  }

  function renderMass(mass, slots, sacristy, highlight) {
    var where = mass.weekday + ' ' + formatDate(mass.date) + ' godz. ' + mass.time;
    var card = el('div', 'card');
    card.setAttribute('role', 'group');
    card.setAttribute('data-key', mass.key);
    card.setAttribute('aria-label', 'Msza: ' + where);
    var head = el('div', 'card-head');
    head.appendChild(el('h3', 'mass-time', mass.time));
    if (mass.description) head.appendChild(el('span', 'description', mass.description));
    var freeCount = mass.slots.filter(function (x) { return !x.taken; }).length;
    var count = el('span', 'mass-count' + (freeCount ? ' has-free' : ''), 'Wolne: ' + freeCount + ' z ' + mass.slots.length);
    head.appendChild(count);
    card.appendChild(head);
    var occ = el('div', 'occ');   // one segment per role: free / taken / yours (the text above carries the same information)
    occ.setAttribute('aria-hidden', 'true');
    mass.slots.forEach(function (x) { occ.appendChild(el('i', x.taken ? (x.mine && !sacristy ? 'm' : 't') : 'f')); });
    card.appendChild(occ);

    // One role per person per mass: once the visitor has a role here, the other free roles are switched off.
    var closed = !sacristy && signupClosed(mass);
    var myRole = sacristy ? '' : roleOfVisitor(mass);
    if (closed) card.appendChild(el('p', 'has-role closed-note', 'Zapisy na tę Mszę są zamknięte (na ' + ((data && data.closeMinutes) || 15) + ' minut przed jej rozpoczęciem). Jeśli możesz pomóc, zgłoś się do zakrystii.'));
    if (myRole) card.appendChild(el('p', 'has-role', 'Masz już posługę na tej Mszy: ' + myRole + '. Na jednej Mszy można pełnić tylko jedną.'));

    slots.forEach(function (slot) {
      var row = el('div', 'slot ' + (!slot.taken ? 'is-free' : (slot.mine && !sacristy ? 'is-taken is-mine' : 'is-taken')) + (highlight && slot.taken ? ' match' : ''));
      var info = el('div', 'slot-info');
      info.appendChild(el('span', 'role', slot.role));
      row.appendChild(info);

      if (!slot.taken) {
        if (closed) {
          row.appendChild(el('span', 'state', 'Zamknięte'));
          row.className = row.className.replace('is-free', 'is-closed');
          card.appendChild(row);
          return;
        }
        info.appendChild(el('span', 'free', '＋ Wolne'));
        var signup = el('button', 'btn primary', 'Zapisz się');
        signup.type = 'button';
        signup.setAttribute('aria-label', 'Zapisz się: ' + slot.role + ', ' + where);
        if (myRole) { signup.disabled = true; signup.title = 'Masz już posługę na tej Mszy'; }
        else signup.onclick = function () { openSignup(mass, slot); };
        row.appendChild(signup);
      } else {
        var name = el('span', 'name', slot.name);
        if (sacristy && slot.phone) name.appendChild(el('span', 'phone', ' · ' + slot.phone));
        if (!sacristy && slot.mine) name.appendChild(el('span', 'me', '✓ Twój zapis'));
        info.appendChild(name);
        if (sacristy) {
          var actions = el('div', 'actions');
          var edit = el('button', 'btn small', 'Edytuj'); edit.type = 'button';
          edit.setAttribute('aria-label', 'Edytuj wpis: ' + slot.name + ', ' + slot.role + ', ' + where);
          edit.onclick = function () { openEdit(mass, slot); };
          var del = el('button', 'btn small danger', 'Usuń'); del.type = 'button';
          del.setAttribute('aria-label', 'Usuń wpis: ' + slot.name + ', ' + slot.role + ', ' + where);
          del.onclick = function () { openRemove(mass, slot, true); };
          actions.appendChild(edit); actions.appendChild(del); row.appendChild(actions);
        } else if (!slot.mine) {
          row.appendChild(el('span', 'state', 'Zajęte'));
        } else if (slot.mine) {
          var leave = el('button', 'btn small danger', 'Wypisz mnie'); leave.type = 'button';
          leave.setAttribute('aria-label', 'Wypisz mnie: ' + slot.role + ', ' + where);
          leave.onclick = function () { openRemove(mass, slot, false); };
          row.appendChild(leave);
        }
      }
      card.appendChild(row);
    });
    return card;
  }

  // ------------------------------------------------------------ optimistic updates (until the next refresh confirms them)
  function findSlot(massKey, role) {
    if (!data) return null;
    for (var i = 0; i < data.masses.length; i++) {
      if (data.masses[i].key !== massKey) continue;
      for (var j = 0; j < data.masses[i].slots.length; j++) {
        if (data.masses[i].slots[j].role === role) return data.masses[i].slots[j];
      }
    }
    return null;
  }

  // ------------------------------------------------------------ dialog
  var TEXT_INPUTS = 'input[type="text"], input[type="tel"], input[type="password"]';

  function closeDialog() {
    $('overlay').classList.remove('open');
    $('dialog').classList.remove('wide');
    document.body.classList.remove('modal-open');
    dialogOpen = false; dialogBusy = false;
    var back = lastFocus; lastFocus = null;
    if (back && document.body.contains(back) && typeof back.focus === 'function') { try { back.focus(); } catch (e) {} }
  }

  function setDialogStatus(text, isError) {
    var s = $('dialogStatus');
    s.textContent = text || '';
    s.className = 'dialog-status' + (isError ? ' error' : '');
  }

  /**
   * buttons: [{ text, className, pendingText, action: () => Promise, onClick: () => void }]
   *   action  – async work; the dialog closes when it resolves, shows the error when it rejects
   *   onClick – plain handler, the dialog is NOT closed by it (use it to switch to another dialog)
   *   neither – the button just closes the dialog
   * While an action runs, all buttons are disabled and the clicked one shows a spinner and `pendingText`.
   * opts.wide – wider dialog (for the long information texts).
   */
  function openDialog(title, content, buttons, opts) {
    opts = opts || {};
    if (!dialogOpen) lastFocus = document.activeElement;
    $('dialogTitle').textContent = title;
    $('dialog').classList.toggle('wide', !!opts.wide);
    var body = $('dialogBody');
    body.textContent = '';
    if (content) body.appendChild(content);
    setDialogStatus('');
    var bar = $('dialogButtons');
    bar.textContent = '';
    var primary = null;

    buttons.forEach(function (def) {
      var b = el('button', 'btn ' + (def.className || ''), def.text);
      b.type = 'button';
      if (/primary|danger/.test(def.className || '') && def.action && !primary) primary = b;
      b.onclick = function () {
        if (dialogBusy) return;
        if (def.onClick) { def.onClick(); return; }
        if (!def.action) { closeDialog(); return; }
        var all = bar.querySelectorAll('button');
        Array.prototype.forEach.call(all, function (x) { x.disabled = true; });
        dialogBusy = true;
        b.textContent = '';
        b.appendChild(spinner());
        b.appendChild(document.createTextNode(def.pendingText || 'Proszę czekać…'));
        setDialogStatus(def.pendingText || 'Proszę czekać…');
        def.action().then(function () {
          closeDialog();
        }, function (err) {
          dialogBusy = false;
          b.textContent = def.text;
          Array.prototype.forEach.call(all, function (x) { x.disabled = false; });
          setDialogStatus(err.message, true);
        });
      };
      bar.appendChild(b);
    });

    // Enter in a one-line field confirms the dialog (not in the multi-line text box)
    Array.prototype.forEach.call(body.querySelectorAll(TEXT_INPUTS), function (input) {
      input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && primary) { ev.preventDefault(); primary.click(); } });
    });

    $('overlay').classList.add('open');
    document.body.classList.add('modal-open');
    dialogOpen = true;
    $('dialog').scrollTop = 0;
    var first = body.querySelector('textarea, ' + TEXT_INPUTS);
    (first || $('dialog')).focus();
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    if (dialogOpen && !dialogBusy) closeDialog();
    else setMore(false);
  });
  $('overlay').addEventListener('mousedown', function (ev) { if (ev.target === $('overlay') && !dialogBusy) closeDialog(); });
  $('overlay').addEventListener('keydown', function (ev) {   // keep Tab inside the dialog
    if (ev.key !== 'Tab' || !dialogOpen) return;
    var items = $('dialog').querySelectorAll('button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]), select:not([disabled])');
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (ev.shiftKey && (document.activeElement === first || document.activeElement === $('dialog'))) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  });

  function field(label, type, value, options) {
    options = options || {};
    var wrap = el('div', 'field');
    var id = 'f' + Math.random().toString(36).slice(2, 8);
    var l = el('label', '', label); l.setAttribute('for', id);
    var input = document.createElement('input');
    input.id = id; input.type = type; input.value = value || '';
    input.maxLength = options.max || 60;
    if (options.numeric) input.inputMode = 'numeric';
    if (type === 'text') { input.autocomplete = 'name'; }
    wrap.appendChild(l); wrap.appendChild(input);
    return { wrap: wrap, input: input };
  }

  function area(label, options) {
    options = options || {};
    var wrap = el('div', 'field');
    var id = 'f' + Math.random().toString(36).slice(2, 8);
    var l = el('label', '', label); l.setAttribute('for', id);
    var input = document.createElement('textarea');
    input.id = id; input.rows = options.rows || 5; input.maxLength = options.max || 1000;
    if (options.placeholder) input.placeholder = options.placeholder;
    wrap.appendChild(l); wrap.appendChild(input);
    return { wrap: wrap, input: input };
  }

  function radio(label, value, checked) {
    var wrap = el('label', 'radio');
    var input = document.createElement('input');
    input.type = 'radio'; input.name = 'kind'; input.value = value; input.checked = !!checked;
    wrap.appendChild(input);
    wrap.appendChild(document.createTextNode(label));
    return { wrap: wrap, input: input };
  }

  function massSummary(mass, slot) {
    return el('p', '', capitalize(mass.weekday) + ', ' + formatDate(mass.date) + ', godz. ' + mass.time + ' – ' + slot.role);
  }

  // ------------------------------------------------------------ actions on sign-ups
  function retentionNote(prefix) {
    var note = el('p', 'note', prefix + ' Dane usuwamy automatycznie, najpóźniej ');
    note.appendChild(el('span', '', String(RETENTION_DAYS)));
    note.appendChild(document.createTextNode(' dni po terminie Mszy.'));
    return note;
  }

  /** First name, last name and phone. Saved on this device; a change also updates the person's existing entries. */
  function openProfile(onDone, opts) {
    opts = opts || {};
    var first = !profile;
    var content = el('div');
    content.appendChild(el('p', '', first
      ? (opts.welcome
        ? 'Podaj swoje dane, a od razu zobaczysz swoje zapisy zrobione na dowolnym urządzeniu. Zapamiętamy je na tym urządzeniu, więc nie trzeba ich wpisywać przy każdym zapisie. Wpisz te same dane na każdym urządzeniu. Możesz też pominąć i tylko przeglądać listę.'
        : 'Podaj swoje dane. Zapamiętamy je na tym urządzeniu, więc przy kolejnych zapisach nie trzeba ich wpisywać. Dzięki nim zobaczysz swoje zapisy także na innym urządzeniu, wystarczy wpisać te same dane.')
      : 'Zmiana danych poprawi też Twoje istniejące zapisy na liście.'));
    var f = field('Imię', 'text', profile ? profile.first : '', { max: 30 });
    var l = field('Nazwisko', 'text', profile ? profile.last : '', { max: 30 });
    var t = field('Numer telefonu', 'tel', profile ? fmtPhone(profile.phone) : '', { max: 20 });
    f.input.autocomplete = 'given-name'; l.input.autocomplete = 'family-name'; t.input.autocomplete = 'tel'; t.input.inputMode = 'tel';
    t.input.placeholder = 'np. 600 100 200';
    content.appendChild(f.wrap); content.appendChild(l.wrap); content.appendChild(t.wrap);
    var check = el('p', 'phone-check');   // shows the number as it will be saved, to catch typos
    check.setAttribute('aria-live', 'polite');
    function showCheck() {
      var d = normPhone(t.input.value);
      check.textContent = d ? 'Zapiszemy numer: ' + fmtPhone(d) + '. Sprawdź, czy jest dobry, bo po nim rozpoznajemy Twoje zapisy.' : (t.input.value.trim() ? 'Numer ma mieć 9 cyfr.' : '');
      check.className = 'phone-check' + (d ? '' : ' bad');
    }
    t.input.addEventListener('input', showCheck); showCheck();
    content.appendChild(check);
    content.appendChild(retentionNote('Imię i nazwisko będą widoczne na liście. Numer telefonu widzi tylko zakrystia (kontakt w razie potrzeby) i służy do rozpoznania Twoich zapisów.'));

    var skip = opts.welcome ? { text: 'Pomiń na razie', action: function () { store.set('profileSkipped', '1'); return Promise.resolve(); } } : { text: 'Anuluj' };
    openDialog(first ? 'Twoje dane' : 'Moje dane', content, [
      { text: 'Zapisz dane', className: 'primary', pendingText: 'Zapisuję…', action: function () {
        var fn = f.input.value.replace(/\s+/g, ' ').trim(), ln = l.input.value.replace(/\s+/g, ' ').trim(), ph = normPhone(t.input.value);
        if (fn.length < 2) return Promise.reject(new Error('Podaj imię.'));
        if (ln.length < 2) return Promise.reject(new Error('Podaj nazwisko.'));
        if (!ph) return Promise.reject(new Error('Podaj poprawny numer telefonu (9 cyfr).'));
        var next = { first: fn, last: ln, phone: ph };
        var changed = profile && (profileName(profile) !== profileName(next) || profile.phone !== ph);
        var work = changed
          ? api('updateProfile', { old: ownerPayload(), next: { name: profileName(next), phone: ph } })
          : Promise.resolve({ updated: 0 });
        return work.then(function (res) {
          saveProfile(next);
          if (changed) {
            toast(res && res.updated ? 'Dane zaktualizowane ✔ (zapisy: ' + res.updated + ')' : 'Dane zaktualizowane ✔');
            loadData({ fresh: true });
          } else if (!first) toast('Dane zapisane ✔');
          else loadData({ fresh: true });   // another device may already hold sign-ups for these data
          if (onDone) setTimeout(onDone, 0);
        });
      } },
      skip
    ]);
  }

  function openSignup(mass, slot) {
    var sacristy = !!data.sacristy;
    if (!sacristy && !profile) { openProfile(function () { openSignup(mass, slot); }); return; }
    var content = el('div');
    content.appendChild(massSummary(mass, slot));
    var name = null, phone = null;
    if (sacristy) {
      name = field('Imię i nazwisko', 'text', '');
      content.appendChild(name.wrap);
      phone = field('Telefon (opcjonalnie)', 'tel', '', { max: 20 });
      content.appendChild(phone.wrap);
      content.appendChild(retentionNote('Imię i nazwisko będą widoczne na liście.'));
    } else {
      var who = el('div', 'who');
      who.appendChild(el('span', 'who-label', 'Zapisujesz się jako'));
      who.appendChild(el('strong', 'who-name', profileName(profile)));
      who.appendChild(el('span', 'who-phone', 'tel. ' + fmtPhone(profile.phone)));
      var change = el('button', 'linkbtn', 'To nie Ty? Zmień dane'); change.type = 'button';
      change.onclick = function () { openProfile(function () { openSignup(mass, slot); }); };
      who.appendChild(change);
      content.appendChild(who);
      content.appendChild(retentionNote('Imię i nazwisko będą widoczne na liście, numer telefonu widzi tylko zakrystia.'));
    }

    openDialog('Zapis na posługę', content, [
      { text: 'Zapisz', className: 'primary', pendingText: 'Zapisuję…', action: function () {
        var typedName, typedPhone;
        if (sacristy) {
          typedName = name.input.value.replace(/\s+/g, ' ').trim();
          if (typedName.length < 3) return Promise.reject(new Error('Podaj imię i nazwisko.'));
          typedPhone = phone.input.value.trim();
        } else { typedName = profileName(profile); typedPhone = profile.phone; }
        return api('signUp', { mass: mass.key, role: slot.role, name: typedName, phone: typedPhone, pin: sacristy ? pin : '' })
          .then(function (result) {
            var s = findSlot(mass.key, slot.role);
            if (s) { s.taken = true; s.name = typedName; s.mine = !sacristy; s.id = result.id; s.phone = sacristy ? typedPhone : null; }
            if (!sacristy) { myIds.push(result.id); saveMyIds(); }
            render(); saveCache();
            toast('Zapisano ✔  ' + slot.role + ', ' + mass.weekday + ' ' + formatDate(mass.date));
            loadData({ fresh: true });   // confirm in the background
          }, function (err) {
            loadData({ fresh: true });   // e.g. the slot was just taken: show the current state
            throw err;
          });
      } },
      { text: 'Anuluj' }
    ]);
  }

  function openEdit(mass, slot) {
    var content = el('div');
    content.appendChild(massSummary(mass, slot));
    var name = field('Imię i nazwisko', 'text', slot.name);
    var phone = field('Telefon (opcjonalnie)', 'tel', slot.phone || '', { max: 20 });
    content.appendChild(name.wrap); content.appendChild(phone.wrap);

    openDialog('Edycja wpisu', content, [
      { text: 'Zapisz zmiany', className: 'primary', pendingText: 'Zapisuję zmiany…', action: function () {
        var typedName = name.input.value.replace(/\s+/g, ' ').trim();
        if (typedName.length < 3) return Promise.reject(new Error('Podaj imię i nazwisko.'));
        var typedPhone = phone.input.value.trim();
        return api('editSignup', { id: slot.id, name: typedName, phone: typedPhone, pin: pin }).then(function () {
          var s = findSlot(mass.key, slot.role);
          if (s) { s.name = typedName; s.phone = typedPhone; }
          render();
          toast('Zapisano zmiany ✔');
          loadData({ fresh: true });
        }, function (err) { loadData({ fresh: true }); throw err; });
      } },
      { text: 'Anuluj' }
    ]);
  }

  function openRemove(mass, slot, bySacristy) {
    var content = el('div');
    content.appendChild(el('p', '', slot.name + ' – ' + slot.role + ', ' + mass.weekday + ' ' + formatDate(mass.date) + ', ' + mass.time));
    openDialog(bySacristy ? 'Usunąć wpis?' : 'Wypisać się?', content, [
      { text: bySacristy ? 'Tak, usuń' : 'Tak, wypisz mnie', className: 'danger', pendingText: bySacristy ? 'Usuwam…' : 'Wypisuję…', action: function () {
        return api('removeSignup', { id: slot.id, pin: bySacristy ? pin : '' }).then(function () {
          var s = findSlot(mass.key, slot.role);
          if (s) { s.taken = false; s.name = undefined; s.mine = false; s.id = null; s.phone = null; }
          myIds = myIds.filter(function (x) { return x !== slot.id; }); saveMyIds();
          render(); saveCache();
          toast(bySacristy ? 'Wpis usunięty ✔' : 'Wypisano ✔');
          loadData({ fresh: true });
        }, function (err) { loadData({ fresh: true }); throw err; });
      } },
      { text: 'Nie' }
    ]);
  }

  function toggleSacristyMode() {
    if (pin) {
      pin = ''; store.del('pin');
      data = null;                  // do not keep phone numbers in memory
      loadData({ fresh: true });
      return;
    }
    var input = field('PIN zakrystii', 'password', '', { max: 12, numeric: true });
    openDialog('Tryb zakrystii', input.wrap, [
      { text: 'Włącz', className: 'primary', pendingText: 'Sprawdzam PIN…', action: function () {
        var entered = input.input.value.trim();
        if (!entered) return Promise.reject(new Error('Wpisz PIN.'));
        return api('getData', { pin: entered, myIds: myIds, fresh: true, owner: ownerPayload() }).then(function (result) {
          if (result && result.error === 'PIN') throw new Error('Nieprawidłowy PIN.');
          pin = entered; store.set('pin', pin);
          requestSeq++;             // drop any older in-flight response
          data = result; updatedAt = Date.now(); fromCache = false;
          showBanner('');
          render();
        });
      } },
      { text: 'Anuluj' }
    ]);
  }

  // ------------------------------------------------------------ information dialogs and problem reports
  function infoContent(templateId) {
    var wrap = el('div', 'prose');
    wrap.appendChild($(templateId).content.cloneNode(true));
    applyRetention(wrap);
    return wrap;
  }

  function openHelp() {
    openDialog('Jak korzystać z aplikacji', infoContent('tplHelp'), [
      { text: 'Zgłoś problem lub pomysł', onClick: function () { closeDialog(); openFeedback(); } },
      { text: 'Zamknij', className: 'primary' }
    ], { wide: true });
  }

  function openPrivacy() {
    var content = infoContent('tplPrivacy');
    if (CONFIG.PRIVACY_CONTACT) {
      var p = el('p');
      p.appendChild(el('strong', '', 'Kontakt w sprawie danych: '));
      p.appendChild(document.createTextNode(String(CONFIG.PRIVACY_CONTACT)));
      content.appendChild(p);
    }
    openDialog('Informacja o danych (RODO)', content, [{ text: 'Zamknij', className: 'primary' }], { wide: true });
  }

  function openFeedback() {
    var content = el('div');
    content.appendChild(el('p', 'note', 'Napisz, co nie działa albo co można ulepszyć. Zgłoszenie zostanie wysłane e-mailem do twórcy aplikacji.'));

    var fs = el('fieldset', 'kind');
    fs.appendChild(el('legend', '', 'Rodzaj zgłoszenia'));
    var radios = el('div', 'radios');
    var rProblem = radio('Problem', 'problem', true);
    var rIdea = radio('Pomysł', 'idea', false);
    radios.appendChild(rProblem.wrap); radios.appendChild(rIdea.wrap);
    fs.appendChild(radios);
    content.appendChild(fs);

    var message = area('Opis', { max: FEEDBACK_MAX, rows: 5 });
    var counter = el('div', 'counter', '0 / ' + FEEDBACK_MAX);
    message.input.addEventListener('input', function () { counter.textContent = message.input.value.length + ' / ' + FEEDBACK_MAX; });
    message.wrap.appendChild(counter);
    content.appendChild(message.wrap);

    var contact = field('Kontakt (opcjonalnie)', 'text', '', { max: 100 });
    contact.input.autocomplete = 'off';
    contact.input.placeholder = 'E-mail lub telefon, jeśli chcesz odpowiedź';
    content.appendChild(contact.wrap);

    // honeypot: invisible for people, bots tend to fill it
    var hp = el('div', 'hp');
    hp.setAttribute('aria-hidden', 'true');
    var hpLabel = el('label', '', 'Nie wypełniaj tego pola');
    var hpInput = document.createElement('input');
    hpInput.type = 'text'; hpInput.name = 'website'; hpInput.tabIndex = -1; hpInput.autocomplete = 'off';
    hpLabel.appendChild(hpInput); hp.appendChild(hpLabel);
    content.appendChild(hp);

    content.appendChild(el('p', 'note', 'Podanie kontaktu jest dobrowolne. Zgłoszenia nie są zapisywane na liście zapisów.'));

    openDialog('Zgłoś problem lub pomysł', content, [
      { text: 'Wyślij', className: 'primary', pendingText: 'Wysyłam…', action: function () {
        var text = message.input.value.trim();
        if (text.length < 5) return Promise.reject(new Error('Opisz krótko, czego dotyczy zgłoszenie (co najmniej 5 znaków).'));
        return api('sendFeedback', {
          kind: rIdea.input.checked ? 'idea' : 'problem',
          message: text,
          contact: contact.input.value.trim(),
          website: hpInput.value,
          clientId: clientId(),
          mode: data && data.sacristy ? 'zakrystia' : 'parafianin',
          ua: String(navigator.userAgent || '').slice(0, 200),
          appVersion: APP_VERSION
        }).then(function () {
          toast('Dziękujemy! Zgłoszenie zostało wysłane ✔');
        });
      } },
      { text: 'Anuluj' }
    ]);
  }

  // ------------------------------------------------------------ toolbar menu and filters
  function setMore(open) {
    $('moreMenu').classList.toggle('open', open);
    $('btnMore').setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function menuAction(fn) { return function () { setMore(false); fn(); }; }

  function setFiltersOpen(open) {
    $('filters').classList.toggle('open', open);
    $('btnFilters').setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  // ------------------------------------------------------------ wiring
  applyRetention(document);

  $('btnRefresh').onclick = function () { loadData({ fresh: true, manual: true }); };
  $('btnHelp').onclick = openHelp;
  $('btnMore').onclick = function (ev) { ev.stopPropagation(); setMore(!$('moreMenu').classList.contains('open')); };
  $('btnProfile').onclick = menuAction(function () { openProfile(); });
  $('btnPrint').onclick = menuAction(function () { window.print(); });
  $('btnFeedback').onclick = menuAction(openFeedback);
  $('btnMode').onclick = menuAction(toggleSacristyMode);
  document.addEventListener('click', function (ev) {
    if (!$('moreMenu').contains(ev.target) && ev.target !== $('btnMore')) setMore(false);
  });

  $('lnkHelp').onclick = openHelp;
  $('lnkPrivacy').onclick = openPrivacy;
  $('lnkFeedback').onclick = openFeedback;

  $('btnFilters').onclick = function () { setFiltersOpen(!$('filters').classList.contains('open')); };
  $('fDate').onchange = function () { filters.date = this.value; if (data) render(); };
  $('fTime').onchange = function () { filters.time = this.value; if (data) render(); };
  $('fPerson').oninput = function () { filters.person = this.value; if (data) render(); };
  $('fFree').onchange = function () { filters.free = this.checked; if (data) render(); };
  $('btnClear').onclick = function () {
    filters = { date: '', time: '', person: '', free: false };
    $('fPerson').value = ''; $('fFree').checked = false;
    if (data) render();
  };

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && !dialogOpen && Date.now() - updatedAt > 20000) loadData({});
  });
  setInterval(function () { if (!document.hidden && !dialogOpen && pending === 0) loadData({}); }, POLL_MS);

  window.addEventListener('online', function () { if (!dialogOpen) loadData({ fresh: true }); });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* the app works without it */ });
  }

  // ------------------------------------------------------------ back to top
  (function () {
    var btn = $('toTop'), ticking = false, visible = false;
    if (!btn) return;
    function update() {
      ticking = false;
      var want = (window.pageYOffset || document.documentElement.scrollTop) > window.innerHeight * 0.8;
      if (want === visible) return;
      visible = want;
      if (want) { btn.hidden = false; requestAnimationFrame(function () { btn.classList.add('show'); }); }
      else { btn.classList.remove('show'); setTimeout(function () { if (!visible) btn.hidden = true; }, 220); }
    }
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    btn.addEventListener('click', function () {
      var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    });
  })();

  // ------------------------------------------------------------ start
  $('appVersion').textContent = APP_VERSION;
  if (!configured()) {
    renderError('Aplikacja nie jest skonfigurowana: w pliku config.js wpisz adres API (kończy się na /exec).');
  } else {
    var cached = pin ? null : loadCache();
    if (cached) {   // paint instantly from the last known list, then refresh
      data = cached.data; updatedAt = cached.at; fromCache = true;
      render();
    }
    loadData({}).then(function () {
      // First visit on this device: ask for the profile right away (skippable), so "Moje zapisy" shows at once.
      if (!profile && !pin && !store.get('profileSkipped', '') && !dialogOpen) openProfile(null, { welcome: true });
    });
  }
})();
