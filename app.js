/*
 * Liturgical ministry sign-ups: front end (GitHub Pages).
 * Talks to the Apps Script web app (see config.js) using JSON over POST with a text/plain body.
 * All user-supplied text is inserted with textContent (never innerHTML).
 * UI texts are in Polish on purpose; identifiers are in English.
 */
(function () {
  'use strict';

  var CONFIG = window.ZAPISY_CONFIG || {};
  var POLL_MS = (CONFIG.POLL_SECONDS || 60) * 1000;
  var TIMEOUT_MS = (CONFIG.REQUEST_TIMEOUT_SECONDS || 40) * 1000;

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

  function formatDate(iso) { var p = iso.split('-'); return p[2] + '.' + p[1]; }
  function todayIso() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function clock(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }

  // ------------------------------------------------------------ state
  var pin = store.get('pin', '');                 // sacristy PIN; empty = normal visitor
  var savedName = store.get('name', '');          // last name used for self-service sign-up
  var myIds = [];                                 // ids of sign-ups made in this browser
  try { myIds = JSON.parse(store.get('myIds', '[]')); if (!Array.isArray(myIds)) myIds = []; } catch (e) { myIds = []; }
  var data = null;                                // last payload: { masses: [...], sacristy: bool }
  var updatedAt = 0;                              // when `data` was fetched (ms)
  var fromCache = false;                          // `data` came from localStorage, not from the server
  var requestSeq = 0;                             // to ignore out-of-order responses
  var pending = 0;                                // number of requests in flight (drives the progress bar)
  var dialogOpen = false;
  var dialogBusy = false;
  var filters = { date: '', time: '', person: '', free: false };

  function saveMyIds() { store.set('myIds', JSON.stringify(myIds)); }

  // ------------------------------------------------------------ API
  function configured() { return typeof CONFIG.API_URL === 'string' && /^https:\/\//.test(CONFIG.API_URL); }

  function setPending(delta) {
    pending = Math.max(0, pending + delta);
    $('progress').hidden = pending === 0;
  }

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

  function userError(message) { var e = new Error(message); e.user = true; return e; }

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

  /** opts.fresh: bypass the server cache (after a change / manual refresh). opts.quiet: no loading panel. */
  function loadData(opts) {
    opts = opts || {};
    var seq = ++requestSeq;
    var firstLoad = !data;
    if (firstLoad) renderLoading();
    var refreshBtn = $('btnRefresh');
    if (opts.manual) { refreshBtn.disabled = true; refreshBtn.textContent = ''; refreshBtn.appendChild(spinner()); refreshBtn.appendChild(document.createTextNode('Odświeżam…')); }

    return api('getData', { pin: pin, myIds: myIds, fresh: !!opts.fresh }).then(function (result) {
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

  function optionsSignature(values) { return values.join('|'); }

  /** Rebuilds a <select> only when its option set changed (so an open dropdown is not disturbed). */
  function fillSelect(select, firstLabel, options, current) {
    var signature = optionsSignature(options.map(function (o) { return o.value + '=' + o.label; }));
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
      if (!seenD[m.date]) { seenD[m.date] = true; dates.push({ value: m.date, label: m.weekday + ' ' + formatDate(m.date) }); }
      if (!seenT[m.time]) { seenT[m.time] = true; times.push({ value: m.time, label: m.time }); }
    });
    times.sort(function (a, b) { return a.value < b.value ? -1 : 1; });
    filters.date = fillSelect($('fDate'), 'Wszystkie', dates, filters.date);
    filters.time = fillSelect($('fTime'), 'Wszystkie', times, filters.time);
  }

  function filtersActive() { return !!(filters.date || filters.time || filters.person.trim() || filters.free); }

  function render() {
    var sacristy = !!data.sacristy;
    document.body.classList.toggle('sacristy', sacristy);
    $('mode').textContent = sacristy
      ? 'Tryb zakrystii: możesz dopisywać, edytować i usuwać wszystkie wpisy.'
      : 'Wybierz wolne miejsce i naciśnij „Zapisz się”.';
    $('btnMode').textContent = sacristy ? 'Wyłącz tryb zakrystii' : 'Tryb zakrystii';
    if (fromCache) showBanner('Pokazuję dane zapisane w urządzeniu z godz. ' + clock(updatedAt) + '. Trwa aktualizacja…', true);

    updateFilterOptions();
    $('btnClear').hidden = !filtersActive();

    var needle = normalize(filters.person.trim());
    var shown = 0;
    var list = $('list');
    list.textContent = '';

    data.masses.forEach(function (mass) {
      if (filters.date && mass.date !== filters.date) return;
      if (filters.time && mass.time !== filters.time) return;
      var slots = mass.slots.filter(function (slot) {
        if (filters.free && slot.taken) return false;
        if (needle && !(slot.taken && normalize(slot.name).indexOf(needle) >= 0)) return false;
        return true;
      });
      if (!slots.length) return;
      shown++;
      list.appendChild(renderMass(mass, slots, sacristy, !!needle));
    });

    if (!shown) {
      list.appendChild(el('p', 'empty', data.masses.length ? 'Brak wyników dla wybranych filtrów.' : 'Brak terminów. Koordynator musi wygenerować terminy w arkuszu.'));
    }
    $('count').textContent = data.masses.length ? 'Pokazano ' + shown + ' z ' + data.masses.length + ' Mszy' : '';
  }

  function renderMass(mass, slots, sacristy, highlight) {
    var card = el('section', 'card');
    card.appendChild(el('h2', '', mass.weekday + ', ' + formatDate(mass.date) + ' – godz. ' + mass.time));
    if (mass.description) card.appendChild(el('div', 'description', mass.description));
    var where = mass.weekday + ' ' + formatDate(mass.date) + ' godz. ' + mass.time;

    slots.forEach(function (slot) {
      var row = el('div', 'slot' + (highlight && slot.taken ? ' match' : ''));
      var info = el('div', 'slot-info');
      info.appendChild(el('span', 'role', slot.role));
      row.appendChild(info);

      if (!slot.taken) {
        info.appendChild(el('span', 'free', 'wolne'));
        var signup = el('button', 'btn primary', 'Zapisz się');
        signup.type = 'button';
        signup.setAttribute('aria-label', 'Zapisz się: ' + slot.role + ', ' + where);
        signup.onclick = function () { openSignup(mass, slot); };
        row.appendChild(signup);
      } else {
        var name = el('span', 'name', slot.name);
        if (sacristy && slot.phone) name.appendChild(el('span', 'phone', ' · ' + slot.phone));
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
  function closeDialog() {
    $('overlay').classList.remove('open');
    dialogOpen = false; dialogBusy = false;
  }

  function setDialogStatus(text, isError) {
    var s = $('dialogStatus');
    s.textContent = text || '';
    s.className = 'dialog-status' + (isError ? ' error' : '');
  }

  /**
   * buttons: [{ text, className, pendingText, action: () => Promise }]; a button without `action` just closes.
   * While an action runs, all buttons are disabled and the clicked one shows a spinner and `pendingText`.
   */
  function openDialog(title, content, buttons) {
    $('dialogTitle').textContent = title;
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
      if (/primary|danger/.test(def.className || '') && !primary) primary = b;
      b.onclick = function () {
        if (dialogBusy) return;
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

    // Enter in a text field confirms the dialog
    Array.prototype.forEach.call(body.querySelectorAll('input'), function (input) {
      input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && primary) { ev.preventDefault(); primary.click(); } });
    });

    $('overlay').classList.add('open');
    dialogOpen = true;
    var first = body.querySelector('input');
    if (first) first.focus();
  }

  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && dialogOpen && !dialogBusy) closeDialog(); });
  $('overlay').addEventListener('mousedown', function (ev) { if (ev.target === $('overlay') && !dialogBusy) closeDialog(); });

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

  function massSummary(mass, slot) {
    return el('p', '', mass.weekday + ', ' + formatDate(mass.date) + ', godz. ' + mass.time + ' – ' + slot.role);
  }

  // ------------------------------------------------------------ actions
  function openSignup(mass, slot) {
    var sacristy = !!data.sacristy;
    var content = el('div');
    content.appendChild(massSummary(mass, slot));
    var name = field('Imię i nazwisko', 'text', sacristy ? '' : savedName);
    content.appendChild(name.wrap);
    var phone = null;
    if (sacristy) { phone = field('Telefon (opcjonalnie)', 'tel', '', { max: 20 }); content.appendChild(phone.wrap); }

    openDialog('Zapis na posługę', content, [
      { text: 'Zapisz', className: 'primary', pendingText: 'Zapisuję…', action: function () {
        var typedName = name.input.value.replace(/\s+/g, ' ').trim();
        if (typedName.length < 3) return Promise.reject(new Error('Podaj imię i nazwisko.'));
        var typedPhone = phone ? phone.input.value.trim() : '';
        return api('signUp', { mass: mass.key, role: slot.role, name: typedName, phone: typedPhone, pin: sacristy ? pin : '' })
          .then(function (result) {
            var s = findSlot(mass.key, slot.role);
            if (s) { s.taken = true; s.name = typedName; s.mine = !sacristy; s.id = result.id; s.phone = sacristy ? typedPhone : null; }
            if (!sacristy) { myIds.push(result.id); saveMyIds(); savedName = typedName; store.set('name', savedName); }
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
        return api('getData', { pin: entered, myIds: myIds, fresh: true }).then(function (result) {
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

  // ------------------------------------------------------------ wiring
  $('btnRefresh').onclick = function () { loadData({ fresh: true, manual: true }); };
  $('btnPrint').onclick = function () { window.print(); };
  $('btnMode').onclick = toggleSacristyMode;

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

  // ------------------------------------------------------------ start
  if (!configured()) {
    renderError('Aplikacja nie jest skonfigurowana: w pliku config.js wpisz adres API (kończy się na /exec).');
  } else {
    var cached = pin ? null : loadCache();
    if (cached) {   // paint instantly from the last known list, then refresh
      data = cached.data; updatedAt = cached.at; fromCache = true;
      render();
    }
    loadData({});
  }
})();
