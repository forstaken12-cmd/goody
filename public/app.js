(function () {
  'use strict';

  const MASCOT_SVG = '<svg viewBox="0 0 90 110" aria-hidden="true"><defs><linearGradient id="gGlass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#D8E8E6"/></linearGradient><linearGradient id="gJam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF8A7A"/><stop offset="1" stop-color="#E23B32"/></linearGradient><linearGradient id="gLid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3EE0C8"/><stop offset="1" stop-color="#0AAF9A"/></linearGradient></defs><ellipse cx="45" cy="104" rx="24" ry="4.5" fill="#0A6F68" opacity="0.16"/><path d="M20 44c0-4 4-7 8-7h34c4 0 8 3 8 7v40c0 15-11 24-25 24S20 99 20 84V44z" fill="url(#gGlass)"/><path d="M24 58c2-10 8-14 21-14s19 4 21 14v24c0 11-8 18-21 18S24 93 24 82V58z" fill="url(#gJam)"/><path d="M29 62c4-5 10-7 16-7 5 0 10 2 13 5" fill="none" stroke="#FFC4BC" stroke-width="2.2" stroke-linecap="round" opacity="0.75"/><path d="M27 50c-2 6-2 13-2 20" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity="0.75"/><rect x="23" y="32" width="44" height="13" rx="4" fill="url(#gLid)"/><rect x="23" y="32" width="44" height="5" rx="2.5" fill="#fff" opacity="0.28"/><rect x="28" y="24" width="34" height="11" rx="4" fill="#3EE0C8"/><rect x="28" y="24" width="34" height="4" rx="2" fill="#fff" opacity="0.35"/><circle cx="45" cy="29" r="1.6" fill="#fff"/><ellipse cx="36" cy="70" rx="4.6" ry="5.5" fill="#fff"/><ellipse cx="54" cy="70" rx="4.6" ry="5.5" fill="#fff"/><circle cx="37.4" cy="71.4" r="2" fill="#17333A"/><circle cx="55.4" cy="71.4" r="2" fill="#17333A"/><circle cx="36" cy="69.4" r="0.8" fill="#fff"/><circle cx="54" cy="69.4" r="0.8" fill="#fff"/><path d="M38 81c4 5.5 10 5.5 14 0" fill="none" stroke="#17333A" stroke-width="2" stroke-linecap="round"/><ellipse cx="29" cy="80" rx="3.6" ry="2.1" fill="#FF8A7A" opacity="0.55"/><ellipse cx="61" cy="80" rx="3.6" ry="2.1" fill="#FF8A7A" opacity="0.55"/></svg>';

  const GLYPH = {
    dragon: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M13 3c.4 3 1.6 5 4 6 2 4 3 7 1 10-2 0-4-.4-5.5-1.5C11 19 8 20 5 19c1-2 2-3.2 2.2-4.5C5 13 4 10.5 5 8c2 .3 3.5 1 4.5 2.2C10 6.5 11.2 4 13 3z"/><circle cx="10.2" cy="11.2" r="1.15" fill="#F25A1F"/></svg>',
    puzzle: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M9 3.5h4.2c0 1.6 1.2 2.6 2.5 2.6S18 5.1 18 3.5H21v6.2c-1.6 0-2.7 1.1-2.7 2.5S19.4 14.7 21 14.7V21h-6.3c0-1.5-1.1-2.6-2.5-2.6S9.7 19.5 9.7 21H3v-6.3c1.6 0 2.7-1.1 2.7-2.5S4.6 9.7 3 9.7V3.5H9z"/></svg>',
    chef: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M8 10c-2 0-3.5-1.6-3.5-3.4C4.5 4.8 6.2 3.5 8 4c.7-1.6 2.2-2.5 4-2.5S15.3 2.4 16 4c1.8-.5 3.5.8 3.5 2.6 0 1.8-1.5 3.4-3.5 3.4H16v8.5H8V10z"/><rect x="8" y="19" width="8" height="3" rx="1"/></svg>',
    rocket: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12 2.5c3.2 3.2 5.5 8 5.5 12.2l-5.5 2.3-5.5-2.3C6.5 10.5 8.8 5.7 12 2.5z"/><circle cx="12" cy="10" r="1.6" fill="#0A8F86"/><path d="M8.2 15.4L5 21l5-1.8M15.8 15.4L19 21l-5-1.8"/></svg>',
    bubble: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8"><circle cx="10" cy="12" r="6.2"/><circle cx="16.5" cy="8" r="3.4"/><circle cx="8.2" cy="9.5" r="1.2" fill="#fff" stroke="none" opacity="0.85"/></svg>',
    meow: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M5 11l2.2-6 3.2 4h3.2L16.8 5 19 11c0 4.2-3.1 7-7 7s-7-2.8-7-7z"/></svg>',
    newsly: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8"><rect x="5" y="4" width="14" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>',
    fitloop: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"><path d="M4 14c2-6 4-8 8-8s6 2 8 8"/><circle cx="12" cy="16" r="3"/></svg>',
    'tune-town': '<svg viewBox="0 0 24 24" fill="#fff"><path d="M9 4v11a3 3 0 1 0 2 3V9h7v6a3 3 0 1 0 2 3V6H11V4H9z"/></svg>',
    'garden-idle': '<svg viewBox="0 0 24 24" fill="#fff"><path d="M12 3c4 4 4 8 2 10-1 0-2-.4-3-1-1 3-3 6-6 8 4-1 8-1 11 1-1-4 0-8 3-11-3 0-6-2-7-7z"/></svg>',
    survey: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9"><rect x="6" y="3.5" width="12" height="17" rx="2.5" fill="#fff" stroke="none"/><path d="M9 3.5h6v2.6H9z" fill="#2A9FD8" stroke="none"/><path d="M9 11h6M9 14.5h4" stroke="#2A9FD8"/></svg>'
  };
  const COIN = '<svg class="coin-ic" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#F5C44A"/><circle cx="8" cy="7.4" r="3" fill="#FFE9A0" opacity="0.7"/><circle cx="10" cy="10" r="5.6" fill="none" stroke="#C88410" stroke-width="1.15"/></svg>';

  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmt(n) { return Math.floor(n || 0).toLocaleString('en-US'); }
  function fmtUsd(n) {
    if (!n) return '$0.00';
    if (n > 0 && n < 0.01) return '< $0.01';
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fingerprint() {
    let id = localStorage.getItem('goody-device-id');
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) || ('dev-' + Math.random().toString(36).slice(2) + Date.now());
      localStorage.setItem('goody-device-id', id);
    }
    return id;
  }
  function reduced() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  let signedIn = false;
  let me = null;
  let offers = [];
  let history = [];
  let cashouts = [];
  let category = 'all';
  let sort = 'highest';
  let histStatus = 'all';
  let currentTab = 'home';
  let currentPay = 'lightning';
  let muted = localStorage.getItem('goody-muted') === '1';
  let audioCtx = null;
  let pollTimer = 0;
  let shownPts = 0;
  let openOfferId = null;

  async function api(path, opts) {
    opts = opts || {};
    const headers = { Accept: 'application/json' };
    if (opts.body != null) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      credentials: 'same-origin',
      headers,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !opts.allow401) {
      signedIn = false;
      showAuth('signup');
      const err = new Error(data.error || 'Please sign in.');
      err.status = 401;
      err.data = data;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function showAuth(which) {
    const ov = $('auth-overlay');
    if (ov) ov.classList.add('show');
    const su = $('form-signup'), li = $('form-login'), fo = $('form-forgot');
    if (!su) return;
    su.hidden = which !== 'signup';
    li.hidden = which !== 'login';
    fo.hidden = which !== 'forgot';
    const showOauth = which !== 'forgot';
    ['oauth-stack', 'oauth-legal', 'oauth-or'].forEach((id) => {
      if ($(id)) $(id).hidden = !showOauth;
    });
    if ($('ts-auth')) $('ts-auth').hidden = !showOauth || !turnstileSiteKey;
    $('auth-title').textContent = which === 'login' ? 'Welcome back' : (which === 'forgot' ? 'Reset password' : 'Goody');
    $('auth-lead').textContent = which === 'login'
      ? 'Sign in to see your points.'
      : (which === 'forgot' ? 'We’ll email a link if that account exists.' : 'Do little tasks. Get points. Cash out when you’re ready.');
  }

  let contactEmail = 'forstaken12@gmail.com';
  function applyContactEmail(email) {
    const addr = String(email || '').trim() || 'forstaken12@gmail.com';
    contactEmail = addr;
    document.querySelectorAll('[data-contact-email]').forEach((el) => {
      el.textContent = addr;
      if (el.tagName === 'A') el.setAttribute('href', 'mailto:' + addr);
    });
  }

  let turnstileSiteKey = null;
  const tsWidgets = {};
  function setupTurnstile(siteKey) {
    if (!siteKey) return;
    turnstileSiteKey = siteKey;
    ['ts-auth', 'ts-forgot'].forEach((id) => { if ($(id)) $(id).hidden = false; });
    window.__goodyTsReady = () => {
      ['ts-auth', 'ts-forgot'].forEach((id) => {
        const el = $(id);
        if (!el || tsWidgets[id] != null || !window.turnstile) return;
        tsWidgets[id] = window.turnstile.render(el, {
          sitekey: siteKey,
          theme: 'auto',
          appearance: 'always'
        });
      });
    };
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__goodyTsReady';
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }
  function captchaToken(id) {
    if (!turnstileSiteKey) return '';
    if (!window.turnstile || tsWidgets[id] == null) return '';
    return window.turnstile.getResponse(tsWidgets[id]) || '';
  }
  function resetCaptcha(id) {
    if (window.turnstile && tsWidgets[id] != null) {
      try { window.turnstile.reset(tsWidgets[id]); } catch (e) { /* ignore */ }
    }
  }
  const CHECK_MSG = 'Please finish the quick check.';

  function applyOauthButtons(oauth) {
    oauth = oauth || {};
    [['btn-google', 'oauth-google-item', !!oauth.google],
     ['btn-apple', 'oauth-apple-item', !!oauth.apple]].forEach(([id, wrapId, on]) => {
      const b = $(id);
      if (!b) return;
      b.disabled = !on;
      b.setAttribute('aria-disabled', on ? 'false' : 'true');
      b.classList.toggle('is-soon', !on);
      if ($(wrapId)) $(wrapId).classList.toggle('is-soon', !on);
    });
  }

  function friendlyAuthError(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/quick check/i.test(s)) return CHECK_MSG;
    if (/cancelled/i.test(s)) return 'Sign-in was cancelled.';
    if (/expired/i.test(s)) return 'That sign-in link expired. Please try again.';
    if (/18 or older|agree to the Terms/i.test(s)) return 'Please confirm you are 18 or older and agree to the Terms and Privacy Policy.';
    if (/already has an account/i.test(s)) return 'That email already has an account. Try signing in with your password.';
    if (/already used/i.test(s)) return 'That email is already used on another account.';
    return 'Sign-in could not be finished. Please try again.';
  }

  function showOauthError(raw) {
    const el = $('oauth-err');
    if (!el) return;
    el.textContent = friendlyAuthError(raw);
  }

  function startOauth(provider) {
    const err = $('oauth-err');
    if (err) err.textContent = '';
    if (!$('su-age') || !$('su-age').checked || !$('su-agree') || !$('su-agree').checked) {
      showOauthError('Please confirm you are 18 or older and agree to the Terms and Privacy Policy.');
      return;
    }
    const q = new URLSearchParams({ agree: '1', age: '1', fingerprint: fingerprint() });
    if (turnstileSiteKey) {
      const tok = captchaToken('ts-auth');
      if (!tok) { showOauthError(CHECK_MSG); return; }
      q.set('turnstileToken', tok);
    }
    window.location.href = '/api/auth/' + provider + '/start?' + q.toString();
  }

  function hideAuth() {
    const ov = $('auth-overlay');
    if (ov) ov.classList.remove('show');
  }

  async function afterSignIn() {
    signedIn = true;
    hideAuth();
    await refresh();
    await loadOffers();
    requestAnimationFrame(moveTabInk);
  }

  async function refresh() {
    me = await api('/api/me');
    renderMe();
    if (currentTab === 'history' || (me.balance && me.balance.pending > 0)) await loadHistory();
    if (currentTab === 'cash') await loadCashouts();
    schedulePoll();
    return me;
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    const pending = me && me.balance && me.balance.pending > 0;
    if (pending) pollTimer = setTimeout(() => refresh().catch(() => {}), 1600);
  }

  /* sound / haptic / fx (same spirit as v2) */
  function ctx() {
    if (muted) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  function beep(freq, dur, type, vol) {
    const c = ctx();
    if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type || 'triangle';
    o.frequency.setValueAtTime(freq, c.currentTime);
    g.gain.setValueAtTime(vol || 0.06, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0008, c.currentTime + dur);
    o.connect(g); g.connect(c.destination);
    o.start(); o.stop(c.currentTime + dur + 0.02);
  }
  function soundOk() { beep(520, 0.1, 'triangle', 0.06); setTimeout(() => beep(780, 0.14, 'triangle', 0.05), 80); }
  function soundTick() { beep(880, 0.045, 'sine', 0.03); }
  function haptic(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 10); } catch (e) { /* ignore */ } }

  function toast(title, msg) {
    const box = $('toasts');
    const d = document.createElement('div');
    d.className = 'toast';
    d.innerHTML = '<h4>' + escapeHtml(title) + '</h4>' + (msg ? '<p>' + escapeHtml(msg) + '</p>' : '');
    box.appendChild(d);
    setTimeout(() => { d.classList.add('hide'); setTimeout(() => d.remove(), 300); }, 2600);
  }
  function celebrate(fromEl) {
    if (reduced()) return;
    const fx = $('fx');
    if (!fx) return;
    const r = fromEl && fromEl.getBoundingClientRect ? fromEl.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight * 0.4, width: 0, height: 0 };
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const colors = ['#E2453A', '#0FBEA8', '#F5C44A', '#FF6B5C', '#7EE8D8', '#FFF8F2'];
    for (let i = 0; i < 28; i++) {
      const p = document.createElement('i');
      p.className = 'confetti';
      p.style.left = x + 'px'; p.style.top = y + 'px';
      p.style.background = colors[i % colors.length];
      p.style.setProperty('--dx', ((Math.random() * 2 - 1) * 160) + 'px');
      p.style.setProperty('--dy', (-40 - Math.random() * 180) + 'px');
      p.style.setProperty('--rot', (Math.random() * 400 - 200) + 'deg');
      fx.appendChild(p);
      setTimeout(() => p.remove(), 1100);
    }
    const target = $('bal-pts');
    if (!target) return;
    const t = target.getBoundingClientRect();
    for (let i = 0; i < 5; i++) {
      const c = document.createElement('div');
      c.className = 'fly-coin';
      c.style.left = (x - 11) + 'px';
      c.style.top = (y - 11) + 'px';
      fx.appendChild(c);
      setTimeout(() => {
        c.style.left = (t.left + 16) + 'px';
        c.style.top = (t.top + 10) + 'px';
        c.style.transform = 'scale(0.35)';
        c.style.opacity = '0.15';
      }, 30 + i * 40);
      setTimeout(() => c.remove(), 900 + i * 40);
    }
  }

  function glyph(id) { return GLYPH[id] || GLYPH.survey; }
  function tileHtml(id) {
    return '<div class="prog-ring off tile-wrap"><div class="app-tile t-' + id + '"><span class="tile-gloss"></span>' + glyph(id) + '</div></div>';
  }
  function ptsPill(pts) {
    return '<div class="pts-pill">' + COIN + '<span>+' + fmt(pts) + '</span></div>';
  }

  function goalNeed() {
    if (!me) return 500;
    if (!me.firstCashoutDone) return Math.round(me.firstCashoutUsd / me.pointUsd);
    return Math.round((me.mins && me.mins.lightning ? me.mins.lightning : 0.8) / me.pointUsd);
  }

  function paintPts(n) {
    if ($('bal-num')) $('bal-num').textContent = fmt(n);
    if ($('cash-num')) $('cash-num').textContent = fmt(n);
    const usd = n * ((me && me.pointUsd) || 0.001);
    $('bal-usd').textContent = '≈ ' + fmtUsd(usd);
    $('cash-usd').textContent = '≈ ' + fmtUsd(usd);
    const need = goalNeed();
    const pct = Math.max(0, Math.min(1, n / need));
    $('goal-bar').style.width = (pct * 100).toFixed(1) + '%';
    $('goal-val').textContent = 'Goal: ' + fmt(n) + ' / ' + fmt(need) + ' pts';
    $('goal-row').classList.toggle('ready', n >= need);
  }

  function renderMe() {
    if (!me) return;
    const demo = !!me.demo;
    $('demo-badge').hidden = !demo;
    const welc = $('welcome-demo');
    if (welc) welc.hidden = !demo;
    const vb = $('verify-banner');
    if (vb) vb.hidden = !!(me.emailVerified);
    const pts = me.balance.available;
    if (reduced() || pts === shownPts) {
      shownPts = pts;
      paintPts(pts);
    } else {
      const from = shownPts, to = pts, start = performance.now();
      const tick = (now) => {
        const t = Math.min(1, (now - start) / 620);
        shownPts = Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3)));
        paintPts(shownPts);
        if (t < 1) requestAnimationFrame(tick);
        else { shownPts = to; paintPts(to); }
      };
      requestAnimationFrame(tick);
    }
    const pend = me.balance.pending || 0;
    const pl = $('pending-line');
    if (pend > 0) {
      pl.hidden = false;
      pl.textContent = fmt(pend) + ' pts checking…';
    } else pl.hidden = true;

    $('streak-num').textContent = String(me.streak.current || 0);
    $('streak-label').textContent = (me.streak.current === 1) ? 'day' : 'days';
    const btn = $('btn-daily');
    if (me.streak.checkedInToday) {
      btn.textContent = 'Done';
      btn.disabled = true;
      btn.classList.remove('pulse');
    } else {
      btn.textContent = 'Check in';
      btn.disabled = false;
      btn.classList.add('pulse');
    }
    $('goal-list').innerHTML = (me.goals || []).map((g) => {
      const pct = Math.min(100, (g.progress / g.target) * 100);
      return '<li><div>' + escapeHtml(g.label) +
        '<div class="g-bar"><i style="width:' + pct + '%"></i></div></div>' +
        (g.done ? '<span class="done-mark">Done</span>' : '<span class="note">' + g.progress + '/' + g.target + '</span>') +
        '</li>';
    }).join('');

    const first = !me.firstCashoutDone;
    $('first-callout').hidden = !first;
    const mins = me.mins || { lightning: 0.8, paypal: 1.2, gift: 2 };
    const firstUsd = me.firstCashoutUsd || 0.5;
    $('min-ln').textContent = 'min ' + fmtUsd(first ? firstUsd : mins.lightning);
    $('min-pp').textContent = 'min ' + fmtUsd(first ? firstUsd : mins.paypal);
    $('min-gift').textContent = 'min ' + fmtUsd(first ? firstUsd : mins.gift);
    renderWalletBtn();
  }

  function offerCard(o, rec) {
    const badge = o.badge ? '<span class="tag ' + o.badge.toLowerCase() + '">' + o.badge + '</span>' : '';
    const kind = o.type === 'playtime' ? 'Playtime' : o.type === 'survey' ? 'Survey' : 'App';
    const cta = o.type === 'playtime' ? 'Play' : 'Start';
    return '<article class="card compact offer-card' + (rec ? ' rec' : '') + '" data-offer="' + o.id + '">' +
      tileHtml(o.id) +
      '<div class="offer-body"><h3>' + escapeHtml(o.name) + '</h3>' +
      '<div class="meta">' + badge + '<span class="tag ' + String(o.difficulty || '').toLowerCase() + '">' + escapeHtml(o.difficulty || kind) + '</span>' +
      o.minutes + ' min</div>' +
      '<div class="note">' + escapeHtml(o.task) + '</div></div>' +
      '<div class="offer-actions">' + ptsPill(o.points) +
      '<button type="button" class="go start-btn" data-offer="' + o.id + '">' + cta + '</button>' +
      '</div></article>';
  }

  async function loadOffers() {
    const data = await api('/api/offers?category=' + encodeURIComponent(category) + '&sort=' + encodeURIComponent(sort));
    offers = data.offers || [];
    $('offer-list').innerHTML = offers.length
      ? offers.map((o, i) => offerCard(o, i === 0)).join('')
      : '<p class="note">No offers in this list.</p>';
    const feat = offers.filter((o) => o.category !== 'surveys').slice(0, 2);
    if ($('feat-list')) $('feat-list').innerHTML = (feat.length ? feat : offers.slice(0, 2)).map((o, i) => offerCard(o, i === 0)).join('');
  }

  function statusLabel(s) {
    if (s === 'pending') return 'Checking';
    if (s === 'paid') return 'Paid';
    if (s === 'rejected') return 'Rejected';
    if (s === 'requested') return 'Requested';
    if (s === 'approved') return 'Approved';
    if (s === 'sent') return 'Sent';
    return s;
  }

  async function loadHistory() {
    const data = await api('/api/history?status=' + encodeURIComponent(histStatus));
    history = data.entries || [];
    const box = $('hist-list');
    if (!history.length) {
      box.innerHTML = '<p class="empty">Nothing here yet</p>';
      return;
    }
    box.innerHTML = history.map((e) => {
      const when = new Date(e.updatedAt || e.createdAt);
      const t = when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const title = e.note || (e.source === 'cashout' ? 'Cash out' : e.source);
      const sign = e.type === 'debit' ? '−' : '+';
      const st = e.type === 'debit' && e.status === 'pending' ? 'requested' : e.status;
      return '<div class="hist-row">' +
        '<div><h3>' + escapeHtml(title) + '</h3><div class="when">' + t + '</div></div>' +
        '<div class="amt">' + sign + fmt(e.points) + ' pts</div>' +
        '<span></span><span class="st-pill ' + st + '">' + statusLabel(st) + '</span>' +
        '</div>';
    }).join('');
  }

  async function loadCashouts() {
    const data = await api('/api/cashouts');
    cashouts = data.cashouts || [];
    const box = $('tx-list');
    if (!cashouts.length) {
      box.className = 'empty';
      box.textContent = 'No cash outs yet';
      return;
    }
    box.className = '';
    box.innerHTML = cashouts.map((c) => {
      const when = new Date(c.created_at);
      const t = when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      return '<div class="tx"><div><div>' + escapeHtml(c.method) + ' · ' + escapeHtml(c.destination) + '</div><div class="meta">' + t + '</div></div>' +
        '<div><div>−' + fmt(c.points) + ' pts</div><span class="st-pill ' + c.status + '">' + statusLabel(c.status) + '</span></div></div>';
    }).join('');
  }

  function renderWalletBtn() {
    const minUsd = (!me || !me.firstCashoutDone)
      ? (me && me.firstCashoutUsd) || 0.5
      : (me.mins && me.mins[currentPay]) || 0.8;
    const minPts = Math.round(minUsd / ((me && me.pointUsd) || 0.001));
    const to = ($('pay-to').value || '').trim();
    const okTo = /@/.test(to) || /^ln/i.test(to);
    const okAmt = me && me.balance.available >= minPts;
    const verified = me && me.emailVerified;
    $('btn-cash').disabled = !(okTo && okAmt && verified);
    let msg = '';
    if (me && !verified) msg = 'Please confirm your email before you cash out.';
    else if (to && !okTo) msg = 'Enter a real-looking address or email.';
    else if (to && !okAmt) msg = 'Need ' + fmt(minPts) + ' points for this one.';
    $('wd-msg').textContent = msg;
    document.querySelectorAll('.pay-opt').forEach((b) => b.classList.toggle('on', b.getAttribute('data-pay') === currentPay));
    $('gift-pick').hidden = currentPay !== 'gift';
  }

  function moveTabInk() {
    const ink = $('tab-ink');
    const on = document.querySelector('.tab.active');
    const nav = $('tabs');
    if (!ink || !on || !nav) return;
    const nr = nav.getBoundingClientRect();
    const r = on.getBoundingClientRect();
    ink.style.width = r.width + 'px';
    ink.style.transform = 'translateX(' + (r.left - nr.left) + 'px)';
  }

  function showTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    moveTabInk();
    if (tab === 'offers') loadOffers().catch(() => {});
    if (tab === 'history') loadHistory().catch(() => {});
    if (tab === 'cash') { renderMe(); loadCashouts().catch(() => {}); }
    if (tab === 'home') { renderMe(); loadOffers().catch(() => {}); }
  }

  async function openOffer(id) {
    openOfferId = id;
    const data = await api('/api/offers/' + encodeURIComponent(id));
    const o = data.offer;
    const prog = data.progress;
    let body = '<div class="modal-icon" style="width:64px;margin:0 auto 8px">' + tileHtml(o.id) + '</div>' +
      '<h2 style="text-align:center">' + escapeHtml(o.name) + '</h2>' +
      '<p style="text-align:center">' + escapeHtml(o.task) + '</p>' +
      '<p class="note" style="text-align:center;margin-top:4px">' + escapeHtml(o.difficulty || '') + ' · ' + o.minutes + ' min · +' + fmt(o.points) + ' pts</p>';
    if (o.type === 'playtime' && o.milestones) {
      const mins = (prog && prog.minutes_played) || 0;
      body += '<p class="status">Played: ' + mins + ' min</p><ul class="miles">';
      body += o.milestones.map((m) => {
        const done = mins >= m.minutes;
        return '<li><span class="step-dot"' + (done ? ' style="background:var(--mint);color:#fff"' : '') + '">' + (done ? '✓' : m.minutes) + '</span>' +
          m.minutes + ' min' + ptsPill(m.points) + '</li>';
      }).join('') + '</ul>';
      if (me && me.demo) {
        body += '<button class="btn-block" id="btn-play">Simulate 5 min</button>';
      }
    } else if (o.steps) {
      body += '<ul class="steps">' + o.steps.map((s, i) => '<li><span class="step-dot">' + (i + 1) + '</span>' + escapeHtml(s) + '</li>').join('') + '</ul>';
      if (me && me.demo) body += '<button class="btn-block" id="btn-offer-go">Start</button>';
    } else if (me && me.demo) {
      body += '<button class="btn-block" id="btn-offer-go">Start</button>';
    }
    body += '<button class="btn-block btn-ghost" id="btn-offer-close">Close</button>';
    $('offer-modal').innerHTML = body;
    $('offer-overlay').classList.add('show');
    const go = $('btn-offer-go');
    const play = $('btn-play');
    const cl = $('btn-offer-close');
    if (go) go.onclick = () => startOffer(o.id);
    if (play) play.onclick = () => playOffer(o.id, 5);
    if (cl) cl.onclick = () => { $('offer-overlay').classList.remove('show'); openOfferId = null; };
  }

  async function startOffer(id) {
    try {
      await api('/api/offers/' + encodeURIComponent(id) + '/start', { method: 'POST', body: { outcome: 'paid' } });
      toast('Started', 'We’ll check this in a moment.');
      $('offer-overlay').classList.remove('show');
      soundOk(); haptic(10);
      await refresh();
      await loadHistory();
      showTab('history');
    } catch (e) {
      toast('Couldn’t start', e.message);
    }
  }

  async function playOffer(id, minutes) {
    try {
      const r = await api('/api/offers/' + encodeURIComponent(id) + '/play', { method: 'POST', body: { minutes } });
      if (r.fired && r.fired.length) {
        toast('Nice!', 'A playtime step is being checked.');
        soundOk(); haptic([8, 20, 8]);
        celebrate($('offer-modal'));
      } else {
        toast('Saved', 'Played ' + r.minutes + ' min.');
      }
      await openOffer(id);
      await refresh();
    } catch (e) {
      toast('Couldn’t update', e.message);
    }
  }

  function renderHow() {
    const you = me ? Math.round(me.sharePct * 100) : 70;
    const b = me ? me.balance : { partnerUsd: 0, userUsd: 0, paidIn: 0, paidOut: 0, available: 0, pending: 0 };
    $('how-body').innerHTML =
      '<p>Partners pay us when you finish a task. You get ' + you + '%. We keep the rest.</p>' +
      '<p>Points come only from those partner payments. After you ask to cash out, a person checks the request and sends it. Nothing is sent automatically yet.</p>' +
      (me && me.demo ? '<p>Demo mode is on. Offers and payments here are pretend, so you can try the full path.</p>' : '') +
      '<div class="how-stats">Partners paid: ' + fmtUsd(b.partnerUsd) +
      '<br>Your share: ' + fmtUsd(b.userUsd) +
      '<br>Points in: ' + fmt(b.paidIn) +
      '<br>Cashed out: ' + fmt(b.paidOut) +
      '<br>Checking now: ' + fmt(b.pending) +
      '<br>Your points now: ' + fmt(b.available) + '</div>' +
      '<p class="acct-contact">Contact us: <a data-contact-email href="mailto:' + escapeHtml(contactEmail) + '">' + escapeHtml(contactEmail) + '</a></p>';
  }

  /* events */
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b) showTab(b.dataset.tab);
  });
  $('btn-mute').addEventListener('click', () => {
    muted = !muted;
    localStorage.setItem('goody-muted', muted ? '1' : '0');
    renderMute();
    if (!muted) soundTick();
  });
  function renderMute() {
    const icon = $('icon-vol');
    if (muted) {
      icon.innerHTML = '<path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M16 9l6 6M22 9l-6 6"/>';
      $('btn-mute').setAttribute('aria-label', 'Unmute');
    } else {
      icon.innerHTML = '<path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 010 7"/><path d="M18 6a8 8 0 010 12"/>';
      $('btn-mute').setAttribute('aria-label', 'Mute');
    }
  }
  function renderAccount() {
    if (!me) return;
    $('acct-email').textContent = me.email || '';
    $('acct-verify').textContent = me.emailVerified ? 'Email confirmed.' : 'Please confirm your email. Check the server log if email is not set up yet.';
  }
  $('btn-gear').addEventListener('click', () => { renderAccount(); $('account-overlay').classList.add('show'); });
  $('btn-account-close').addEventListener('click', () => $('account-overlay').classList.remove('show'));
  $('btn-how').addEventListener('click', () => {
    $('account-overlay').classList.remove('show');
    renderHow();
    $('how-overlay').classList.add('show');
  });
  $('btn-how-close').addEventListener('click', () => $('how-overlay').classList.remove('show'));
  $('btn-logout').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch (e) { /* still leave */ }
    me = null;
    signedIn = false;
    $('account-overlay').classList.remove('show');
    showAuth('login');
  });
  const gBtn = $('btn-google');
  const aBtn = $('btn-apple');
  if (gBtn) gBtn.addEventListener('click', () => { if (!gBtn.disabled) startOauth('google'); });
  if (aBtn) aBtn.addEventListener('click', () => { if (!aBtn.disabled) startOauth('apple'); });
  $('go-login').addEventListener('click', () => showAuth('login'));
  $('go-signup').addEventListener('click', () => showAuth('signup'));
  $('go-forgot').addEventListener('click', () => showAuth('forgot'));
  $('fo-back').addEventListener('click', () => showAuth('login'));
  $('form-signup').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('su-err').textContent = '';
    try {
      const data = await api('/api/auth/signup', { method: 'POST', body: {
        email: $('su-email').value,
        password: $('su-pass').value,
        agreeTerms: $('su-agree').checked,
        ageConfirm: $('su-age').checked,
        fingerprint: fingerprint(),
        turnstileToken: captchaToken('ts-auth')
      }});
      ctx();
      if (data.mailNote) toast('Account created', data.mailNote);
      else toast('Account created', 'Check your email to confirm it.');
      await afterSignIn();
    } catch (err) { $('su-err').textContent = err.message; resetCaptcha('ts-auth'); }
  });
  $('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('li-err').textContent = '';
    try {
      await api('/api/auth/login', { method: 'POST', body: {
        email: $('li-email').value,
        password: $('li-pass').value,
        fingerprint: fingerprint(),
        turnstileToken: captchaToken('ts-auth')
      }});
      ctx();
      await afterSignIn();
    } catch (err) { $('li-err').textContent = err.message; resetCaptcha('ts-auth'); }
  });
  $('form-forgot').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('fo-err').textContent = '';
    $('fo-ok').textContent = '';
    try {
      const data = await api('/api/auth/forgot', { method: 'POST', body: { email: $('fo-email').value, turnstileToken: captchaToken('ts-forgot') } });
      resetCaptcha('ts-forgot');
      $('fo-ok').textContent = data.mailNote || data.message || 'If that email has an account, we will send a reset link.';
    } catch (err) { $('fo-err').textContent = err.message; resetCaptcha('ts-forgot'); }
  });
  $('btn-resend').addEventListener('click', async () => {
    try {
      const data = await api('/api/auth/resend', { method: 'POST', body: {} });
      toast('Link ready', data.mailNote || 'Check your email.');
    } catch (err) { toast('Couldn’t send', err.message); }
  });
  $('verify-done').addEventListener('click', () => $('verify-overlay').classList.remove('show'));
  $('form-reset').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('rs-err').textContent = '';
    const params = new URLSearchParams(location.search);
    try {
      await api('/api/auth/reset', { method: 'POST', body: { token: params.get('token'), password: $('rs-pass').value } });
      toast('Password saved', 'You can sign in now.');
      $('reset-overlay').classList.remove('show');
      showAuth('login');
      if (history.replaceState) history.replaceState({}, '', '/');
    } catch (err) { $('rs-err').textContent = err.message; }
  });
  $('btn-daily').addEventListener('click', async () => {
    try {
      const r = await api('/api/checkin', { method: 'POST', body: {} });
      if (r.already) toast('Already done', 'Come back tomorrow.');
      else {
        toast('Day ' + r.streak.current, 'Your check-in gift is on the way.');
        soundOk(); haptic(12); celebrate($('btn-daily'));
      }
      await refresh();
    } catch (e) { toast('Couldn’t check in', e.message); }
  });
  function onOfferClick(e) {
    const b = e.target.closest('[data-offer]');
    if (b) openOffer(b.getAttribute('data-offer'));
  }
  $('feat-list').addEventListener('click', onOfferClick);
  $('offer-list').addEventListener('click', onOfferClick);
  $('filter-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    category = b.getAttribute('data-cat');
    $('filter-row').querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
    loadOffers().catch(() => {});
  });
  $('sort-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    sort = b.getAttribute('data-sort');
    $('sort-row').querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
    loadOffers().catch(() => {});
  });
  $('hist-filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-st]');
    if (!b) return;
    histStatus = b.getAttribute('data-st');
    $('hist-filter').querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
    loadHistory().catch(() => {});
  });
  document.querySelectorAll('.pay-opt').forEach((b) => {
    b.addEventListener('click', () => { currentPay = b.getAttribute('data-pay'); renderWalletBtn(); });
  });
  $('pay-to').addEventListener('input', renderWalletBtn);
  $('btn-cash').addEventListener('click', () => {
    if (!$('pay-to').value.trim() || !me) return;
    const dest = $('pay-to').value.trim();
    const label = currentPay === 'lightning' ? 'Bitcoin' : currentPay === 'paypal' ? 'PayPal' : ($('gift-kind').value + ' card');
    const amt = me.balance.available;
    $('wd-modal').innerHTML =
      '<h2>Cash out?</h2>' +
      '<p>Send <strong>' + fmt(amt) + ' pts</strong> (' + fmtUsd(amt * me.pointUsd) + ') as ' + escapeHtml(label) + ' to<br><strong>' + escapeHtml(dest) + '</strong></p>' +
      '<p style="margin-top:10px;font-size:13px">We’ll look it over, then send it. This is not automatic yet.</p>' +
      '<button class="btn-block" id="wd-confirm">Request</button>' +
      '<button class="btn-block btn-ghost" id="wd-cancel">Cancel</button>';
    $('wd-overlay').classList.add('show');
    $('wd-cancel').onclick = () => $('wd-overlay').classList.remove('show');
    $('wd-confirm').onclick = async () => {
      try {
        const r = await api('/api/cashout', { method: 'POST', body: { method: currentPay, destination: dest } });
        celebrate($('wd-modal'), { noCoins: true });
        soundOk(); haptic([10, 30, 10]);
        $('wd-modal').innerHTML = '<h2>Requested</h2><p>' + fmt(r.cashout.points) + ' points are held while we check this. You’ll see it in History.</p><button class="btn-block" id="wd-done">Okay</button>';
        $('wd-done').onclick = () => $('wd-overlay').classList.remove('show');
        me.balance = r.balance;
        me.firstCashoutDone = true;
        renderMe();
        loadCashouts();
      } catch (e) {
        toast('Couldn’t send', e.message);
        $('wd-overlay').classList.remove('show');
      }
    };
  });

  document.addEventListener('pointerdown', (e) => {
    const t = e.target.closest && e.target.closest('.go, .btn-block, .tab, .start-btn, .pay-opt, .chip, .icon-btn');
    if (!t || reduced()) return;
    soundTick();
    const r = t.getBoundingClientRect();
    const s = document.createElement('span');
    s.className = 'ripple';
    const size = Math.max(r.width, r.height) * 1.2;
    s.style.width = s.style.height = size + 'px';
    s.style.left = (e.clientX - r.left - size / 2) + 'px';
    s.style.top = (e.clientY - r.top - size / 2) + 'px';
    t.appendChild(s);
    setTimeout(() => s.remove(), 520);
  });
  window.addEventListener('resize', moveTabInk);

  $('mascot').innerHTML = MASCOT_SVG;
  if ($('welcome-mascot')) $('welcome-mascot').innerHTML = MASCOT_SVG;
  renderMute();

  window.__GOODY = {
    get me() { return me; },
    goto: showTab,
    refresh, loadOffers, loadHistory, openOffer, startOffer, playOffer,
    showAuth, afterSignIn
  };

  const bootParams = new URLSearchParams(location.search);
  if (bootParams.get('authError')) {
    showOauthError(bootParams.get('authError'));
    if (history.replaceState) history.replaceState({}, '', location.pathname || '/');
  }

  async function boot() {
    try {
      const cfg = await fetch('/api/config', { credentials: 'same-origin' }).then((r) => r.json());
      if ($('welcome-demo')) $('welcome-demo').hidden = !cfg.demo;
      if ($('demo-badge') && !signedIn) $('demo-badge').hidden = !cfg.demo;
      applyOauthButtons(cfg.oauth);
      applyContactEmail(cfg.contactEmail);
      setupTurnstile(cfg.turnstileSiteKey);
    } catch (e) { /* ignore */ }
    const path = location.pathname;
    const params = new URLSearchParams(location.search);
    if (path === '/reset' && params.get('token')) {
      $('reset-overlay').classList.add('show');
    }
    if (path === '/verify' && params.get('token')) {
      $('verify-overlay').classList.add('show');
      try {
        await api('/api/auth/verify', { method: 'POST', body: { token: params.get('token') } });
        $('verify-msg').textContent = 'Your email is confirmed. Thank you.';
        if (history.replaceState) history.replaceState({}, '', '/');
      } catch (e) {
        $('verify-msg').textContent = e.message || 'This link is old or already used.';
      }
    }
    try {
      const st = await fetch('/api/auth/status', { credentials: 'same-origin' }).then((r) => r.json());
      if (!st.signedIn) {
        showAuth(path === '/reset' ? 'login' : 'signup');
        return;
      }
      // The sign-in overlay starts visible in the HTML. After Google/Apple
      // (a full page load with a session cookie), we must hide it here.
      await afterSignIn();
    } catch (e) {
      showAuth(path === '/reset' ? 'login' : 'signup');
    }
  }
  boot().catch((e) => {
    showAuth('signup');
    if (e && e.status !== 401) toast('Couldn’t load', e.message);
  });
})();
