/* ============================================================================
 * Tavo · Варианты ответа бота — расширение для SillyTavern
 * После сообщения ИГРОКА бот НЕ отвечает автоматически — вместо этого под
 * репликой игрока появляется панель: варианты того, как может ответить БОТ
 * (с типами, цветами, бабочками и карточкой-загадкой). Выбор варианта пишет
 * ПЕРВЫЙ (и единственный) ответ бота на это сообщение.
 * Генерация — нативная, через настроенное в SillyTavern подключение:
 *   - варианты и тизер: generateRaw (мета-задача, вне чата)
 *   - ответ бота:       generateQuietPrompt(quietToLoud) -> дописываем в чат
 * Автоответ глушится через stopGeneration() на GENERATION_AFTER_COMMANDS
 * (только type==='normal' — наши quiet-генерации не трогаются).
 * Хранилище — в message.extra сообщения игрока. Namespace ti3- / tavo_reply_*.
 * ========================================================================== */
(function () {
  'use strict';

  // ===== НАСТРОЙКИ =====
  var VARIANTS_COUNT = 5;          // сколько вариантов генерировать (загадка сверх этого)
  var SHOW_MYSTERY = true;         // карточка «Угадай, что ответит бот»
  var CONTEXT_MESSAGES = 12;       // сколько последних сообщений отдавать модели
  var INTERCEPT_AUTO_REPLY = true; // глушить авто-ответ бота после сообщения юзера
  // =====================

  var PANEL_CLASS = 'tavo-reply-panel';

  var OPTIONS_SYSTEM = 'You are my co-writer for an ongoing roleplay. You are given the recent scene as a transcript, '
    + 'ending with the player\'s latest message. Propose concrete, genuinely different ways the CHARACTER(S) / bot could '
    + 'respond to that message RIGHT NOW, grounded in the actual characters, place, and tensions of THIS specific scene. '
    + 'For EACH option, first classify it with EXACTLY ONE type from this list (in Russian): '
    + 'Драма, Романтика, Спокойствие, Напряжение, Тайна, Неожиданное. Vary the types across options. '
    + 'Write the Заголовок and the sentence in the SAME language as the transcript. Reply ONLY as separate lines, '
    + 'each formatted EXACTLY like this, with two " :: " separators: Тип :: Заголовок :: одно яркое конкретное предложение. '
    + 'No numbering, no preamble, no closing remarks — just the lines.';

  var TEASER_SYSTEM = 'You are a teaser generator, not a roleplayer. Given a roleplay scene transcript ending with the '
    + 'player\'s message, output ONE short cryptic teaser of 3 to 6 words that hints at the FLAVOR of how the character '
    + 'might surprisingly respond. No spoilers, no story, no character post, no reasoning, no quotes. CRITICAL: reply '
    + 'STRICTLY in the SAME language as the transcript (if it is in Russian, reply in Russian).';

  var STEER_TPL = '[Now write the character\'s reply to the user\'s latest message, taking it in THIS direction: {DIR}. '
    + 'Stay fully in-character as the character(s) and the world, advance the scene vividly, and end on a hook that '
    + 'demands the user react. Never speak or act for the user. Match the established style, POV and formatting.]';

  var RISK_PROMPT = '[Now write the character\'s reply to the user\'s latest message with a genuinely SURPRISING, '
    + 'unexpected turn the reader would NOT predict — a twist, an intrusion, or a reversal — while staying true to the '
    + 'established characters, tone, and world. Be bold but coherent, advance the scene, and end on a hook. Never speak '
    + 'or act for the user. Match the established style, POV and formatting.]';

  var TYPES = {
    'драма': { e: '🔥', c: '#ff5c7a' }, 'драм': { e: '🔥', c: '#ff5c7a' },
    'романтик': { e: '💗', c: '#ff77c8' }, 'роман': { e: '💗', c: '#ff77c8' },
    'спокой': { e: '🌿', c: '#4fd1a1' },
    'напряж': { e: '⚡', c: '#ffb454' },
    'тайн': { e: '🔍', c: '#a99bff' }, 'загадк': { e: '🔍', c: '#a99bff' },
    'неожид': { e: '🎲', c: '#5cc8ff' }, 'сюрприз': { e: '🎲', c: '#5cc8ff' }
  };
  function typeOf(s) {
    var k = (s || '').toLowerCase().trim();
    for (var key in TYPES) { if (k.indexOf(key) > -1) return { name: s.trim(), e: TYPES[key].e, c: TYPES[key].c }; }
    return { name: (s || 'Вариант').trim(), e: '🎬', c: 'currentColor' };
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  var BSVG = '<svg class="ti3-bf" viewBox="0 0 100 90">'
    + '<g class="wl"><path d="M50 44 C30 16,8 10,6 30 C0 42,9 50,27 47 C42 45,49 47,50 44Z" opacity=".62"/><path d="M50 46 C34 56,14 62,13 77 C15 88,32 83,43 68 C49 60,50 51,50 46Z" opacity=".5"/></g>'
    + '<g class="wr"><path d="M50 44 C70 16,92 10,94 30 C100 42,91 50,73 47 C58 45,51 47,50 44Z" opacity=".62"/><path d="M50 46 C66 56,86 62,87 77 C85 88,68 83,57 68 C51 60,50 51,50 46Z" opacity=".5"/></g>'
    + '<ellipse cx="50" cy="52" rx="2" ry="13" opacity=".9"/></svg>';
  var FLYCFG = [
    { top: '6%', w: 42, op: .30, d: 14, dl: 0, f: .24 },
    { top: '20%', w: 30, op: .26, d: 18, dl: -3, f: .28 },
    { top: '38%', w: 24, op: .23, d: 12, dl: -6, f: .22 },
    { top: '56%', w: 46, op: .28, d: 16, dl: -2, f: .26 },
    { top: '70%', w: 22, op: .22, d: 20, dl: -8, f: .30 },
    { top: '12%', w: 28, op: .24, d: 15, dl: -5, f: .25 },
    { top: '48%', w: 36, op: .26, d: 13, dl: -9, f: .27 },
    { top: '78%', w: 26, op: .22, d: 17, dl: -4, f: .23 }
  ];
  var FLIES = '<div class="ti3-flies">' + FLYCFG.map(function (c, i) {
    return '<span class="ti3-fly" style="top:' + c.top + ';width:' + c.w + 'px;height:' + c.w + 'px;opacity:' + c.op + ';--fd:' + c.f + 's;animation:ti3-f' + ((i % 6) + 1) + ' ' + c.d + 's ease-in-out infinite;animation-delay:' + c.dl + 's">' + BSVG + '</span>';
  }).join('') + '</div>';

  function ctx() { return SillyTavern.getContext(); }

  function toast(msg) {
    try {
      var c = ctx();
      if (c.toastr && c.toastr.error) c.toastr.error(msg);
      else if (window.toastr) window.toastr.error(msg);
      else console.warn('[tavo-reply]', msg);
    } catch (e) { console.warn('[tavo-reply]', msg); }
  }

  function buildTranscript() {
    var c = ctx();
    var chat = c.chat || [];
    var slice = chat.filter(function (m) { return m && !m.is_system; }).slice(-CONTEXT_MESSAGES);
    return slice.map(function (m) {
      var who = m.is_user ? (c.name1 || 'User') : (m.name || c.name2 || 'Character');
      return who + ': ' + (m.mes || '');
    }).join('\n');
  }

  // Через полный конвейер (generateQuietPrompt) — с карточкой/джейлбреком пресета, иначе «голый»
  // generateRaw режется контент-фильтром провайдера (напр. Gemini: PROHIBITED_CONTENT / prompt_blocked).
  async function genOptions() {
    var instr = '[OOC planning task — do NOT write story prose and do NOT continue the roleplay. '
      + OPTIONS_SYSTEM + ' Give EXACTLY ' + VARIANTS_COUNT + ' options for the bot\'s reply now, as ' + VARIANTS_COUNT + ' lines only.]';
    return await ctx().generateQuietPrompt({ quietPrompt: instr, quietToLoud: false });
  }
  async function genTeaser() {
    var instr = '[OOC task — do NOT continue the roleplay. ' + TEASER_SYSTEM + ' Output only the short teaser phrase now.]';
    return await ctx().generateQuietPrompt({ quietPrompt: instr, quietToLoud: false });
  }
  // Полный ответ бота: генерим «громко» с инструкцией, дописываем как сообщение персонажа (первый ответ).
  async function genReply(quietPrompt) {
    var c = ctx();
    var text = await c.generateQuietPrompt({ quietPrompt: quietPrompt, quietToLoud: true });
    text = (text || '').trim();
    if (!text) throw new Error('пустой ответ модели');
    var mes = { name: c.name2 || 'Character', is_user: false, is_system: false, send_date: Date.now(), mes: text, extra: {} };
    c.chat.push(mes);
    c.addOneMessage(mes);
    await c.saveChat();
    return text;
  }

  function parse(raw) {
    return String(raw || '').split(/\r?\n/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s.indexOf('::') > -1; })
      .map(function (l) {
        var p = l.split('::').map(function (x) { return x.trim(); });
        if (p.length >= 3) { return { type: p[0].replace(/^[-*\d.\s]+/, ''), title: p[1], desc: p.slice(2).join(' :: ') }; }
        return { type: '', title: p[0].replace(/^[-*\d.\s]+/, ''), desc: p.slice(1).join(' :: ') };
      }).slice(0, VARIANTS_COUNT);
  }

  // ---- хранилище: в message.extra сообщения игрока ----
  function storeOf(idx) {
    var m = ctx().chat[idx];
    if (!m) return null;
    if (!m.extra) m.extra = {};
    return m.extra;
  }
  function getIdeas(idx) { var e = storeOf(idx); return (e && e.tavo_reply_ideas) || null; }
  function setIdeas(idx, items) { var e = storeOf(idx); if (e) { e.tavo_reply_ideas = items; ctx().saveChat(); } }
  function getCollapsed(idx) { var e = storeOf(idx); return e ? e.tavo_reply_collapsed : undefined; }
  function setCollapsedStore(idx, v) { var e = storeOf(idx); if (e) { e.tavo_reply_collapsed = v; ctx().saveChat(); } }

  function buildPanelDom() {
    var panel = document.createElement('div');
    panel.className = 'ti3-panel ' + PANEL_CLASS;
    panel.innerHTML =
      '<div class="ti3-head"><span class="ti3-title">🎬 варианты ответа бота<span class="ti3-count"></span></span>'
      + '<span class="ti3-head-btns">'
      + '<button class="ti3-skip" type="button" title="пропустить — пусть бот ответит сам" aria-label="пропустить">⏭</button>'
      + '<button class="ti3-toggle" type="button" aria-label="свернуть">▾</button>'
      + '</span></div>'
      + '<div class="ti3-body"><div class="ti3-out"></div></div>';
    return panel;
  }

  function initPanel(panel, idx) {
    if (panel.dataset.ti3Bound) return;
    panel.dataset.ti3Bound = '1';

    var head = panel.querySelector('.ti3-head');
    var toggle = panel.querySelector('.ti3-toggle');
    var skip = panel.querySelector('.ti3-skip');
    var countEl = panel.querySelector('.ti3-count');
    var out = panel.querySelector('.ti3-out');

    // ⏭ пропустить развилку — пусть бот ответит сам (обычная генерация)
    if (skip) {
      skip.addEventListener('click', async function (e) {
        e.stopPropagation();
        skip.disabled = true; skip.textContent = '⏳';
        try {
          window.__tavoReplyAllowNormal = true; // разрешаем нашему перехватчику пропустить этот ответ
          panel.remove();
          await ctx().generate('normal');
          pokeAll();
        } catch (err) {
          window.__tavoReplyAllowNormal = false;
          toast('Ошибка: ' + ((err && err.message) || err));
          scheduleRefresh();
        }
      });
    }

    function setCount(n) { countEl.textContent = n ? (' · ' + n) : ''; }
    function setCollapsed(v) { panel.classList.toggle('collapsed', !!v); setCollapsedStore(idx, v ? 1 : 0); }

    function renderCards(items) {
      setCount(items.length + (SHOW_MYSTERY ? 1 : 0));
      var cards = items.map(function (it, i) {
        var t = typeOf(it.type);
        var style = '--acc:' + t.c + ';animation-delay:' + (i * 0.06).toFixed(2) + 's';
        return '<div class="ti3-card" style="' + style + '">' + FLIES
          + '<div class="ti3-badge"><span>' + t.e + '</span>' + esc(t.name) + '</div>'
          + '<b>' + esc(it.title) + '</b>'
          + '<p>' + esc(it.desc) + '</p>'
          + '<button class="ti3-go" type="button" data-steer="' + esc(it.desc) + '">▶️ пусть бот так ответит</button>'
          + '</div>';
      }).join('');
      var MCARD = SHOW_MYSTERY ? ('<div class="ti3-card ti3-mystery" style="--acc:#b06cff">' + FLIES
        + '<div class="ti3-badge"><span>❓</span>Загадка</div>'
        + '<div class="ti3-q">🎴</div>'
        + '<b>Угадай, что ответит бот</b>'
        + '<p>Бот сам придумает неожиданный ответ — ты не увидишь его заранее. Рискнёшь?</p>'
        + '<div class="ti3-teaser"></div>'
        + '<button class="ti3-risk" type="button">🎲 Рискнуть</button>'
        + '<button class="ti3-peek" type="button">🙈 подсмотреть одним глазком</button>'
        + '</div>') : '';
      var mCount = SHOW_MYSTERY ? 1 : 0;
      var total = items.length + mCount, dots = '';
      for (var j = 0; j < total; j++) { dots += '<span class="ti3-dot' + (j === 0 ? ' on' : '') + '"></span>'; }
      out.innerHTML = '<div class="ti3-view"><div class="ti3-track">' + cards + MCARD + '</div></div>'
        + '<div class="ti3-ctrls"><button class="ti3-nav ti3-prev" type="button">‹</button><div class="ti3-dots">' + dots + '</div><button class="ti3-nav ti3-next" type="button">›</button></div>'
        + '<button class="ti3-reroll" type="button">🔄 другие варианты</button>';

      var track = out.querySelector('.ti3-track');
      var dotEls = [].slice.call(out.querySelectorAll('.ti3-dot'));
      var N = dotEls.length, cur = 0;
      function show(k) { cur = Math.max(0, Math.min(N - 1, k)); track.style.transform = 'translateX(-' + (cur * 100) + '%)'; dotEls.forEach(function (d, j) { d.classList.toggle('on', j === cur); }); }
      dotEls.forEach(function (d, j) { d.addEventListener('click', function () { show(j); }); });
      out.querySelector('.ti3-prev').addEventListener('click', function () { show(cur - 1); });
      out.querySelector('.ti3-next').addEventListener('click', function () { show(cur + 1); });
      out.querySelectorAll('.ti3-card').forEach(function (card) { card.addEventListener('click', function (e) { if (e.target.closest('button')) return; show((cur + 1) % N); }); });
      var sx = null;
      track.addEventListener('touchstart', function (e) { sx = e.touches[0].clientX; }, { passive: true });
      track.addEventListener('touchend', function (e) { if (sx === null) return; var dx = e.changedTouches[0].clientX - sx; if (dx > 40) show(cur - 1); else if (dx < -40) show(cur + 1); sx = null; });
      out.querySelector('.ti3-reroll').addEventListener('click', function () { generate(); });

      var risk = out.querySelector('.ti3-risk');
      if (risk) {
        risk.addEventListener('click', async function () {
          var og = risk.textContent; risk.disabled = true; risk.textContent = '🎲 бросаю кости…';
          try { await genReply(RISK_PROMPT); risk.textContent = '✅ сюрприз!'; pokeAll(); }
          catch (e) { risk.disabled = false; risk.textContent = og; toast('Ошибка: ' + ((e && e.message) || e)); }
        });
      }
      var peek = out.querySelector('.ti3-peek');
      var teaserEl = out.querySelector('.ti3-teaser');
      if (peek) {
        peek.addEventListener('click', async function () {
          var og = peek.textContent; peek.disabled = true; peek.textContent = '🙈 подсматриваю…';
          try {
            var tz = await genTeaser();
            var clean = (tz || '').replace(/<[^>]*>/g, '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean)[0] || '';
            clean = clean.replace(/^["«»\-\s]+/, '').replace(/["«».\s]+$/, '');
            if (teaserEl) { teaserEl.textContent = '🔮 ' + clean; teaserEl.style.display = 'block'; }
            peek.textContent = '🙈 ещё намёк'; peek.disabled = false;
          } catch (e) { peek.disabled = false; peek.textContent = og; toast('Ошибка: ' + ((e && e.message) || e)); }
        });
      }
      out.querySelectorAll('.ti3-go').forEach(function (g) {
        g.addEventListener('click', async function () {
          var steer = g.getAttribute('data-steer'); var og = g.textContent; g.disabled = true; g.textContent = '✍️ бот пишет…';
          try { await genReply(STEER_TPL.replace('{DIR}', steer)); g.textContent = '✅ готово'; pokeAll(); }
          catch (e) { g.disabled = false; g.textContent = og; toast('Ошибка: ' + ((e && e.message) || e)); }
        });
      });
    }

    function showGenButton() {
      setCount(0);
      out.innerHTML = '<button class="ti3-btn" type="button"><span class="ti3-btn-txt">✨ придумать варианты ответа</span></button>';
      out.querySelector('.ti3-btn').addEventListener('click', function () { generate(); });
    }

    async function generate() {
      setCollapsed(false);
      out.innerHTML = '<div class="ti3-cap">✨ подбираю варианты ответа…</div><div class="ti3-skel"></div><div class="ti3-skel"></div><div class="ti3-skel"></div>';
      try {
        var raw = await genOptions();
        var items = parse(raw);
        if (!items.length) { out.innerHTML = '<div class="ti3-card"><p>Пусто — попробуй ещё раз 🔄</p></div>'; return; }
        setIdeas(idx, items);
        renderCards(items);
      } catch (e) { out.innerHTML = '<div class="ti3-card"><p>⚠️ ' + esc((e && e.message) || e) + '</p></div>'; }
    }

    toggle.addEventListener('click', function (e) { e.stopPropagation(); setCollapsed(!panel.classList.contains('collapsed')); });
    head.addEventListener('click', function () { setCollapsed(!panel.classList.contains('collapsed')); });
    panel.addEventListener('click', function (e) { e.stopPropagation(); });

    var stored = getIdeas(idx);
    if (stored && stored.length) { renderCards(stored); } else { showGenButton(); }
    var col = getCollapsed(idx);
    if (col === 1) { panel.classList.add('collapsed'); } // РАЗВЁРНУТА по умолчанию (её роль — заменить ответ)
  }

  // ---- размещение панели под последним сообщением ИГРОКА ----
  function refresh() {
    var c;
    try { c = ctx(); } catch (e) { return; }
    var chat = c.chat || [];
    var lastIdx = -1;
    for (var i = chat.length - 1; i >= 0; i--) { if (chat[i] && !chat[i].is_system) { lastIdx = i; break; } }

    document.querySelectorAll('.' + PANEL_CLASS).forEach(function (p) {
      if (p.dataset.mesid !== String(lastIdx)) p.remove();
    });
    if (lastIdx < 0) return;
    if (!chat[lastIdx].is_user) return; // панель ТОЛЬКО под сообщением игрока

    var mesEl = document.querySelector('#chat .mes[mesid="' + lastIdx + '"]') || document.querySelector('.mes[mesid="' + lastIdx + '"]');
    if (!mesEl) return;
    if (document.querySelector('.' + PANEL_CLASS + '[data-mesid="' + lastIdx + '"]')) return;
    var panel = buildPanelDom();
    panel.dataset.mesid = String(lastIdx);
    // сиблингом после сообщения (TavernHelper затирает вставленное внутрь .mes)
    var anchor = mesEl;
    while (anchor.nextElementSibling && anchor.nextElementSibling.className &&
           String(anchor.nextElementSibling.className).indexOf('tavo-') > -1) {
      anchor = anchor.nextElementSibling;
    }
    anchor.insertAdjacentElement('afterend', panel);
    initPanel(panel, lastIdx);
  }

  var refreshTimer = null;
  function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 60); }
  function pokeAll() { window.dispatchEvent(new CustomEvent('tavo-panels-refresh')); }

  function watchChat() {
    var el = document.getElementById('chat');
    if (!el) { setTimeout(watchChat, 500); return; }
    new MutationObserver(scheduleRefresh).observe(el, { childList: true });
  }

  // ---- перехват авто-ответа бота ----
  function onGenAfterCommands(type, opts, dryRun) {
    if (!INTERCEPT_AUTO_REPLY) return;
    if (dryRun) return;
    if (type !== 'normal') return; // наши quiet-генерации не трогаем
    if (window.__tavoReplyAllowNormal) { window.__tavoReplyAllowNormal = false; return; } // ⏭ пропуск разрешён
    try { ctx().stopGeneration(); } catch (e) { console.warn('[tavo-reply] stop fail', e); }
    scheduleRefresh();
  }

  // ---- запуск ----
  function boot() {
    var c;
    try { c = SillyTavern.getContext(); } catch (e) { setTimeout(boot, 300); return; }
    if (!c || !c.eventSource || !c.eventTypes) { setTimeout(boot, 300); return; }
    var es = c.eventSource, et = c.eventTypes;
    [
      et.CHARACTER_MESSAGE_RENDERED, et.USER_MESSAGE_RENDERED, et.CHAT_CHANGED,
      et.MESSAGE_DELETED, et.MESSAGE_SWIPED, et.MESSAGE_EDITED, et.MORE_MESSAGES_LOADED
    ].forEach(function (ev) { if (ev) es.on(ev, scheduleRefresh); });
    if (et.GENERATION_AFTER_COMMANDS) es.on(et.GENERATION_AFTER_COMMANDS, onGenAfterCommands);
    window.addEventListener('tavo-panels-refresh', scheduleRefresh);
    watchChat();
    scheduleRefresh();
    console.log('[tavo-reply] загружено' + (INTERCEPT_AUTO_REPLY ? ' (авто-ответ бота перехватывается)' : ''));
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
