'use strict';
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var app = $('#app'), nav = $('#nav');
  var state = { me: null, plans: {}, demoBilling: true };
  var fileTokens = {}; // unlock tokens for password-protected files, this tab only

  /* ---------- helpers ---------- */
  function h(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  }
  function api(method, url, body, extra) {
    var opts = { method: method, headers: { 'X-Chatbit': '1' }, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || 'Something went wrong.'); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  var tt;
  function toast(msg) { var t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(function () { t.classList.remove('show'); }, 3400); }
  function fmt(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return Math.max(1, Math.round(b / 1024)) + ' KB'; if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB'; return (b / 1073741824).toFixed(1) + ' GB'; }
  function when(ts) { return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  function copy(text) {
    var ok = function () { toast('Copied: ' + text); };
    var no = function () { toast('Copy this: ' + text); };
    try { navigator.clipboard.writeText(text).then(ok, no); } catch (e) { no(); }
  }
  function store(key, val) { try { if (val === undefined) return sessionStorage.getItem(key); sessionStorage.setItem(key, val); } catch (e) { return null; } }

  /* ---------- router ---------- */
  function go(path) { history.pushState({}, '', path); route(); window.scrollTo(0, 0); }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-link]');
    if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); go(a.getAttribute('href')); }
  });
  window.addEventListener('popstate', route);

  function renderNav() {
    nav.textContent = '';
    if (state.me) {
      nav.appendChild(h('a', { href: '/' + state.me.username, 'data-link': true, text: 'My space' }));
      nav.appendChild(h('button', { class: 'btn ghost sm', type: 'button', text: 'Log out', onclick: function () {
        api('POST', '/api/logout').then(function () { state.me = null; renderNav(); go('/'); toast('Logged out.'); });
      } }));
    } else {
      nav.appendChild(h('a', { href: '/#plans', 'data-link': true, text: 'Plans' }));
      nav.appendChild(h('button', { class: 'btn ghost sm', type: 'button', text: 'Log in', onclick: function () { openAuth('login'); } }));
    }
  }

  function route() {
    var m = location.pathname.match(/^\/([a-z0-9_-]{3,20})\/?$/i);
    if (m) renderSpace(m[1].toLowerCase()); else { renderLanding(); if (location.hash) { var t = $(location.hash); if (t) t.scrollIntoView(); } }
  }

  /* ---------- auth dialog ---------- */
  var dlg = $('#authDlg'), mode = 'register';
  function openAuth(m, username) {
    mode = m;
    $('#authTitle').textContent = m === 'register' ? 'Create your space' : 'Log in';
    $('#authSub').textContent = m === 'register' ? 'Pick a password. You can start uploading right away.' : 'Open your own space to upload and manage files.';
    $('#authGo').textContent = m === 'register' ? 'Create space' : 'Log in';
    $('#authSwap').textContent = m === 'register' ? 'Already have a space? Log in' : 'New here? Claim an address';
    $('#aPass').setAttribute('autocomplete', m === 'register' ? 'new-password' : 'current-password');
    $('#authErr').textContent = '';
    if (username != null) $('#aUser').value = username;
    if (!dlg.open) dlg.showModal();
    (username ? $('#aPass') : $('#aUser')).focus();
  }
  $('#authCancel').addEventListener('click', function () { dlg.close(); });
  $('#authSwap').addEventListener('click', function () { openAuth(mode === 'register' ? 'login' : 'register'); });
  $('#authForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('#authGo'); btn.disabled = true;
    var body = { username: $('#aUser').value.trim().toLowerCase(), password: $('#aPass').value };
    api('POST', mode === 'register' ? '/api/register' : '/api/login', body).then(function (r) {
      state.me = r.user; $('#aPass').value = ''; dlg.close(); renderNav(); go('/' + r.user.username);
      toast(mode === 'register' ? 'Your space is ready.' : 'Welcome back.');
    }).catch(function (err) { $('#authErr').textContent = err.message; }).then(function () { btn.disabled = false; });
  });

  /* ---------- landing ---------- */
  function renderLanding() {
    document.title = 'Chatbit';
    app.innerHTML =
      '<div class="hero"><div>' +
      '<p class="eyebrow">File sharing across your own devices</p>' +
      '<h1>Your files, at <em>one address.</em></h1>' +
      '<p class="lede">Claim a personal web address, drop files into it, and open it from any browser. No app to install and no messaging account to sign into on someone else\'s computer.</p>' +
      '<form class="claim" id="claimForm" autocomplete="off"><label for="un"><span class="pre">chatbit.com/</span><input id="un" type="text" placeholder="yourname" maxlength="20" spellcheck="false" autocapitalize="none" aria-describedby="status"></label><button class="btn" type="submit">Claim address</button></form>' +
      '<p class="status" id="status" role="status" aria-live="polite">Choose 3 to 20 letters, numbers, _ or -.</p></div>' +
      '<div class="scene" aria-label="A file moves from a college computer to a phone through a Chatbit address">' +
      '<div class="node"><div class="glyph"></div><div><b>Lab computer</b><span>Upload the report, close the tab</span></div></div>' +
      '<div class="link" data-label="upload"><i class="chip"></i></div>' +
      '<div class="node mid"><div><b>chatbit.com/<span id="sceneName">yourname</span></b><span>Text · images · video · documents · APK</span></div></div>' +
      '<div class="link" data-label="open"></div>' +
      '<div class="node"><div class="glyph phone"></div><div><b>Your phone</b><span>Open the same address, get the file</span></div></div></div></div>' +

      '<section id="why"><div class="sec-head"><p class="eyebrow">The problem</p><h2>Moving a file shouldn\'t need a login.</h2><p>Every usual method asks for something: a free port, an app, or your personal account on a computer you don\'t own.</p></div>' +
      '<div class="tablewrap"><table><thead><tr><th>Method</th><th>Install an app</th><th>Personal mail or chat login</th><th>On a shared computer</th></tr></thead><tbody>' +
      '<tr><td>USB drive</td><td class="n">No</td><td class="n">No</td><td>Needs a free port and is easy to leave behind</td></tr>' +
      '<tr><td>Email attachment</td><td class="n">No</td><td class="y">Yes</td><td>Leaves your inbox open on that machine</td></tr>' +
      '<tr><td>Messaging app</td><td class="y">Often</td><td class="y">Yes</td><td>Signs your personal chats in on that machine</td></tr>' +
      '<tr><td>Cloud storage</td><td class="y">Often</td><td class="y">Yes</td><td>Sign-in on a machine you don\'t control</td></tr>' +
      '<tr class="us"><td>Chatbit</td><td class="n">No</td><td class="n">No</td><td>Open your address, upload, close the tab</td></tr></tbody></table></div></section>' +

      '<section id="how"><div class="sec-head"><p class="eyebrow">How it works</p><h2>Three moves, any browser.</h2></div><div class="steps">' +
      '<div class="step"><span class="n0">STEP 1</span><h3>Claim your address</h3><p>Pick a name and get a link such as chatbit.com/riya that is yours.</p></div>' +
      '<div class="step"><span class="n0">STEP 2</span><h3>Upload anything</h3><p>Documents, photos, videos, APKs and notes go into one space from whatever device is in front of you.</p></div>' +
      '<div class="step"><span class="n0">STEP 3</span><h3>Open it elsewhere</h3><p>Visit the same address on another device. Your files are there, with nothing to install.</p></div></div>' +
      '<p class="story"><strong>A common case.</strong> A student finishes a lab report on a college computer, uploads it to their Chatbit space, and opens it on their phone on the way home.</p></section>' +

      '<section id="plans"><div class="sec-head"><p class="eyebrow">Plans</p><h2>Free to start. Paid when you need control.</h2><p>Basic sharing is free. Premium adds protection, room and permissions.</p></div><div class="plans">' +
      '<div class="plan"><h3>Free</h3><div class="price">₹0 <small>forever</small></div><ul id="freeList"></ul><button class="btn ghost" type="button" id="freeBtn">Claim a free address</button></div>' +
      '<div class="plan pro"><h3>Premium</h3><div class="price">₹99 <small>per month, sample price</small></div><ul id="proList"></ul><button class="btn" type="button" id="proBtn">Start with Premium</button></div></div></section>';

    var P = state.plans, f = P.free || {}, p = P.premium || {};
    [['#freeList', [
      'A personal address', 'Text, images, video, documents and APKs',
      (f.maxFiles || 10) + ' items, ' + fmt(f.maxBytes || 0) + ' storage, ' + fmt(f.maxFileBytes || 0) + ' per file']],
     ['#proList', [
      'Password protection for single files and your whole space',
      'Private and public access per file (permissions)',
      (p.maxFiles || 500) + ' items, ' + fmt(p.maxBytes || 0) + ' storage, ' + fmt(p.maxFileBytes || 0) + ' per file']]]
      .forEach(function (x) { var ul = $(x[0]); x[1].forEach(function (t) { ul.appendChild(h('li', { text: t })); }); });

    var un = $('#un'), st = $('#status'), timer;
    function check() {
      var v = un.value.trim().toLowerCase();
      $('#sceneName').textContent = v || 'yourname';
      st.className = 'status';
      if (!v) { st.textContent = 'Choose 3 to 20 letters, numbers, _ or -.'; return Promise.resolve(null); }
      return api('GET', '/api/check/' + encodeURIComponent(v)).then(function (r) {
        if (un.value.trim().toLowerCase() !== v) return null;
        if (r.available) { st.textContent = 'chatbit.com/' + v + ' is available.'; st.classList.add('ok'); return v; }
        st.textContent = r.reason; st.classList.add('bad'); return null;
      }).catch(function () { return null; });
    }
    un.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(check, 250); });
    $('#claimForm').addEventListener('submit', function (e) {
      e.preventDefault();
      if (state.me) return go('/' + state.me.username);
      check().then(function (v) { if (v) openAuth('register', v); else un.focus(); });
    });
    $('#freeBtn').addEventListener('click', function () { if (state.me) go('/' + state.me.username); else { window.scrollTo(0, 0); un.focus(); } });
    $('#proBtn').addEventListener('click', function () {
      if (state.me) go('/' + state.me.username); else { openAuth('register'); toast('Create a space first, then switch to Premium from your space.'); }
    });
  }

  /* ---------- a space ---------- */
  function downloadUrl(f, username, inline) {
    var q = [];
    if (fileTokens[f.id]) q.push('t=' + encodeURIComponent(fileTokens[f.id]));
    var s = store('sp:' + username); if (s) q.push('s=' + encodeURIComponent(s));
    if (inline) q.push('inline=1');
    return '/api/files/' + f.id + '/download' + (q.length ? '?' + q.join('&') : '');
  }

  function renderSpace(username) {
    document.title = 'chatbit.com/' + username;
    app.textContent = '';
    app.appendChild(h('p', { class: 'empty', text: 'Opening chatbit.com/' + username + '…' }));
    var s = store('sp:' + username);
    api('GET', '/api/space/' + encodeURIComponent(username) + (s ? '?s=' + encodeURIComponent(s) : '')).then(function (sp) {
      if (location.pathname.toLowerCase().replace(/\/$/, '') !== '/' + username) return;
      if (sp.locked) return renderGate(sp);
      drawSpace(sp);
    }).catch(function (err) {
      app.textContent = '';
      var box = h('div', { class: 'gate' }, h('h2', { text: err.status === 404 ? 'Not claimed yet' : 'Could not open this space' }), h('p', { text: err.message }));
      if (err.status === 404 && !state.me) box.appendChild(h('button', { class: 'btn', type: 'button', text: 'Claim chatbit.com/' + username, onclick: function () { openAuth('register', username); } }));
      app.appendChild(box);
    });
  }

  function renderGate(sp) {
    app.textContent = '';
    var input = h('input', { id: 'gatePw', type: 'password', placeholder: 'Space password', autocomplete: 'off' });
    var err = h('p', { class: 'err', role: 'alert' });
    var form = h('form', { class: 'gate', onsubmit: function (e) {
      e.preventDefault();
      api('POST', '/api/space/' + sp.username + '/unlock', { password: input.value }).then(function (r) {
        store('sp:' + sp.username, r.token); renderSpace(sp.username);
      }).catch(function (x) { err.textContent = x.message; });
    } },
      h('p', { class: 'eyebrow', text: 'chatbit.com/' + sp.username }),
      h('h2', { text: 'This space is protected' }),
      h('label', { class: 'eyebrow', for: 'gatePw', text: 'Password' }), input, err,
      h('button', { class: 'btn', type: 'submit', text: 'Open space' }));
    app.appendChild(form); input.focus();
  }

  function drawSpace(sp) {
    app.textContent = '';
    var owner = sp.owner;
    var link = location.origin + '/' + sp.username;
    var badge = h('span', { class: 'badge' });
    app.appendChild(h('div', { class: 'space-head' },
      h('h1', {}, h('span', { text: 'chatbit.com/' }), sp.username), badge));
    if (owner) app.appendChild(h('div', { class: 'sharebar' },
      h('span', { class: 'eyebrow', text: 'Your address' }), h('code', { text: link }),
      h('button', { class: 'btn sm', type: 'button', text: 'Copy', onclick: function () { copy(link); } })));

    var filesBox = h('div', { class: 'files' });
    var body = h('div', { class: 'bench-body' + (owner ? '' : ' solo') }, filesBox);
    app.appendChild(h('div', { class: 'bench' }, body));

    function refresh() {
      var s = store('sp:' + sp.username);
      return api('GET', '/api/space/' + sp.username + (s ? '?s=' + encodeURIComponent(s) : '')).then(function (n) { sp = n; paint(); });
    }

    function paint() {
      badge.textContent = (state.plans[sp.plan] || {}).label || sp.plan;
      filesBox.textContent = '';
      if (!sp.files.length) filesBox.appendChild(h('div', { class: 'empty', text: owner ? 'Nothing here yet. Add a file or save a note and it shows up at this address.' : 'No files are shared here yet.' }));
      sp.files.forEach(function (f) { filesBox.appendChild(fileRow(f)); });
      if (owner) paintSide();
    }

    function fileRow(f) {
      var ico = h('div', { class: 'ico' });
      var unlocked = !f.locked || fileTokens[f.id];
      if (f.kind === 'image' && unlocked && /^image\/(png|jpe?g|gif|webp|avif)$/.test(f.mime)) ico.appendChild(h('img', { src: downloadUrl(f, sp.username, true), alt: '', loading: 'lazy' }));
      else ico.textContent = f.isNote ? 'note' : f.kind === 'document' ? 'doc' : f.kind;
      var vis = f.visibility === 'password' ? 'Password' : f.visibility === 'private' ? 'Private' : 'Public';
      var info = h('div', { class: 'info' }, h('div', { class: 'nm', text: f.name }), h('div', { class: 'meta', text: fmt(f.size) + ' · ' + when(f.createdAt) + (owner ? ' · ' + vis : f.locked ? ' · Password protected' : '') }));
      if (f.text) info.appendChild(h('div', { class: 'snip', text: f.text }));
      var acts = h('div', { class: 'acts' });
      var row = h('div', { class: 'row' }, ico, info, acts);

      if (!unlocked) {
        var pw = h('input', { type: 'password', placeholder: 'Password', 'aria-label': 'Password for ' + f.name, autocomplete: 'off' });
        row.appendChild(h('form', { class: 'unlock', onsubmit: function (e) {
          e.preventDefault();
          api('POST', '/api/files/' + f.id + '/unlock', { password: pw.value }).then(function (r) {
            fileTokens[f.id] = r.token; if (r.text) f.text = r.text; paint();
          }).catch(function (x) { toast(x.message); });
        } }, pw, h('button', { class: 'btn sm', type: 'submit', text: 'Unlock' })));
        return row;
      }
      if (!f.isNote || f.visibility === 'public' || owner || fileTokens[f.id]) {
        acts.appendChild(h('a', { href: downloadUrl(f, sp.username, false), download: f.name, text: 'Download' }));
      }
      if (f.visibility === 'public') acts.appendChild(h('button', { type: 'button', text: 'Copy link', onclick: function () { copy(location.origin + downloadUrl(f, sp.username, false)); } }));
      if (owner) {
        var sel = h('select', { 'aria-label': 'Who can open ' + f.name },
          h('option', { value: 'public', text: 'Public' }), h('option', { value: 'password', text: 'Password' }), h('option', { value: 'private', text: 'Only me' }));
        sel.value = f.visibility;
        sel.addEventListener('change', function () {
          var v = sel.value;
          if (v === 'password') { askPassword(f, row, sel); return; }
          setVis(f, v, undefined, sel);
        });
        acts.appendChild(sel);
        acts.appendChild(h('button', { type: 'button', text: 'Delete', onclick: function () {
          api('DELETE', '/api/files/' + f.id).then(function () { toast('Removed ' + f.name); refresh(); }).catch(function (x) { toast(x.message); });
        } }));
      }
      return row;
    }

    function setVis(f, v, password, sel) {
      api('PATCH', '/api/files/' + f.id, { visibility: v, password: password }).then(function () { refresh(); })
        .catch(function (x) { toast(x.message); if (sel) sel.value = f.visibility; });
    }
    function askPassword(f, row, sel) {
      if (row.querySelector('.unlock')) return;
      var pw = h('input', { type: 'password', placeholder: 'Set a password for this file', autocomplete: 'new-password' });
      var form = h('form', { class: 'unlock', onsubmit: function (e) { e.preventDefault(); setVis(f, 'password', pw.value, sel); } },
        pw, h('button', { class: 'btn sm', type: 'submit', text: 'Save' }),
        h('button', { class: 'btn ghost sm', type: 'button', text: 'Cancel', onclick: function () { sel.value = f.visibility; form.remove(); } }));
      row.appendChild(form); pw.focus();
    }

    function paintSide() {
      var old = $('.side', body); if (old) old.remove();
      var u = sp.usage, L = u.limits, pct = Math.min(100, u.bytes / L.maxBytes * 100);
      var side = h('aside', { class: 'side' });

      var bar = h('i'); bar.style.width = pct + '%';
      side.appendChild(h('div', {},
        h('div', { class: 'meter-t' }, h('span', { text: u.files + ' of ' + L.maxFiles + ' items' }), h('span', { text: fmt(u.bytes) + ' of ' + fmt(L.maxBytes) })),
        h('div', { class: 'meter' }, bar)));

      var progress = h('div', { class: 'meta' });
      var input = h('input', { type: 'file', multiple: true, id: 'picker', 'aria-label': 'Choose files to upload' });
      var drop = h('label', { class: 'drop', for: 'picker' }, h('strong', { text: 'Drop files here' }), 'or tap to choose from this device', input);
      input.addEventListener('change', function () { uploadAll(input.files); input.value = ''; });
      ['dragenter', 'dragover'].forEach(function (n) { drop.addEventListener(n, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
      ['dragleave', 'drop'].forEach(function (n) { drop.addEventListener(n, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
      drop.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) uploadAll(e.dataTransfer.files); });
      side.appendChild(h('div', { class: 'panel' }, drop, progress));

      function uploadAll(list) {
        var queue = Array.prototype.slice.call(list), done = 0;
        (function next() {
          var file = queue.shift();
          if (!file) { progress.textContent = ''; return refresh(); }
          progress.textContent = 'Uploading ' + file.name + ' (' + (++done) + ' of ' + (done + queue.length) + ')';
          var xhr = new XMLHttpRequest();
          xhr.open('PUT', '/api/files?name=' + encodeURIComponent(file.name));
          xhr.setRequestHeader('X-Chatbit', '1');
          xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
          xhr.upload.onprogress = function (e) { if (e.lengthComputable) progress.textContent = 'Uploading ' + file.name + ' ' + Math.round(e.loaded / e.total * 100) + '%'; };
          xhr.onload = function () {
            if (xhr.status >= 300) { var m = 'Upload failed.'; try { m = JSON.parse(xhr.responseText).error || m; } catch (e) {} toast(file.name + ': ' + m); }
            next();
          };
          xhr.onerror = function () { toast(file.name + ': network error.'); next(); };
          xhr.send(file);
        })();
      }

      var ta = h('textarea', { id: 'note', placeholder: 'Paste a link, a code snippet or a reminder for your other device.' });
      side.appendChild(h('div', { class: 'panel' }, h('label', { class: 'eyebrow', for: 'note', text: 'Quick text note' }), ta,
        h('button', { class: 'btn ghost sm', type: 'button', text: 'Save note', onclick: function () {
          api('POST', '/api/notes', { text: ta.value }).then(function () { ta.value = ''; refresh(); }).catch(function (x) { toast(x.message); });
        } })));

      var plan = state.plans[sp.plan] || {};
      var panel = h('div', { class: 'panel' }, h('h3', { text: plan.label + ' plan' }));
      if (sp.plan === 'free') {
        panel.appendChild(h('p', { text: 'Premium adds password protection, private files, and much more room.' }));
        if (state.demoBilling) panel.appendChild(h('button', { class: 'btn sm', type: 'button', text: 'Switch to Premium (demo, no payment)', onclick: function () { setPlan('premium'); } }));
      } else {
        var sp1 = h('input', { type: 'password', id: 'spw', placeholder: sp.protected ? 'New space password' : 'Space password', autocomplete: 'new-password' });
        panel.appendChild(h('p', { text: sp.protected ? 'Visitors need a password to open your space.' : 'Ask visitors for a password before they can see anything here.' }));
        panel.appendChild(h('form', { class: 'unlock', onsubmit: function (e) {
          e.preventDefault();
          api('POST', '/api/space-password', { password: sp1.value }).then(function () { toast('Space password saved.'); refresh(); }).catch(function (x) { toast(x.message); });
        } }, sp1, h('button', { class: 'btn sm', type: 'submit', text: 'Save' })));
        if (sp.protected) panel.appendChild(h('button', { class: 'btn ghost sm', type: 'button', text: 'Remove space password', onclick: function () {
          api('POST', '/api/space-password', { password: '' }).then(function () { toast('Space is public again.'); refresh(); });
        } }));
        if (state.demoBilling) panel.appendChild(h('button', { class: 'linkbtn', type: 'button', text: 'Switch back to Free (demo)', onclick: function () { setPlan('free'); } }));
      }
      side.appendChild(panel);
      body.appendChild(side);
    }

    function setPlan(p) {
      api('POST', '/api/plan', { plan: p }).then(function (r) { state.me = r.user; sp.plan = p; toast('You are on the ' + state.plans[p].label + ' plan.'); refresh(); })
        .catch(function (x) { toast(x.message); });
    }
    paint();
  }

  /* ---------- boot ---------- */
  api('GET', '/api/me').then(function (r) { state.me = r.user; state.plans = r.plans; state.demoBilling = r.demoBilling; })
    .catch(function () {}).then(function () { renderNav(); route(); });
})();
