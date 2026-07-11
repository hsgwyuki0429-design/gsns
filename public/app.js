/* GSNS frontend — vertical game feed with record/replay, likes, comments, upload, PWA. */
(function () {
  'use strict';
  var L = window.L;

  /* ---------- anonymous user id ---------- */
  var uid = localStorage.getItem('gsns_uid');
  if (!uid) {
    uid = (crypto.randomUUID ? crypto.randomUUID() : 'u' + Date.now() + Math.random().toString(36).slice(2));
    localStorage.setItem('gsns_uid', uid);
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'x-gsns-user': uid }, opts.headers || {});
    if (opts.body && typeof opts.body === 'object') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(path, opts).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) {
        var e = new Error(j.error || r.status); e.status = r.status; throw e;
      });
      return r.json();
    });
  }

  /* ---------- state ---------- */
  var feedEl = document.getElementById('feed');
  var games = [];            // game objects from the API
  var slides = [];           // per-game DOM/state, index-aligned with games
  var activeIndex = -1;
  var nextOffset = 0;
  var fetching = false;
  var PRELOAD_AHEAD = 2;     // ④: keep the next two games loaded
  var KEEP_BEHIND = 1;
  var MAX_RECORD_MS = 90000;

  /* ---------- toast ---------- */
  var toastEl = document.getElementById('toast');
  var toastTimer = null;
  function toast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.add('hidden'); }, ms || 2600);
  }

  /* ---------- slide construction ---------- */
  var ICONS = {
    heart: '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.9-10-9.2C.4 8.6 2 5 5.5 5c2 0 3.4 1.1 4.2 2.4l2.3 3.2 2.3-3.2C15.1 6.1 16.5 5 18.5 5 22 5 23.6 8.6 22 11.8 19.5 16.1 12 21 12 21z"/></svg>',
    comment: '<svg viewBox="0 0 24 24"><path d="M12 3C6.5 3 2 6.9 2 11.7c0 2.7 1.4 5.1 3.7 6.7L5 22l4.3-2c.9.2 1.8.3 2.7.3 5.5 0 10-3.9 10-8.7S17.5 3 12 3z"/></svg>',
    share: '<svg viewBox="0 0 24 24"><path d="M14 9V5l8 7-8 7v-4.1C7 14.9 4 17 2 20c1-6 4-10 12-11z"/></svg>',
  };

  function makeSlide(game, index) {
    var el = document.createElement('section');
    el.className = 'slide';
    el.dataset.index = index;
    el.innerHTML =
      '<div class="frame-wrap"></div>' +
      '<div class="spinner"><div class="ring"></div><div>' + L.loading + '</div></div>' +
      '<div class="load-error hidden">' + L.gameUnavailable + '</div>' +
      '<div class="badge hidden"></div>' +
      '<div class="swipe-hint hidden"><div class="chev">︿</div><div class="sh-label"></div></div>' +
      '<div class="meta">' +
      '  <div class="title"></div>' +
      '  <div class="author"></div>' +
      '  <div class="plays"></div>' +
      '</div>' +
      '<div class="rail">' +
      '  <button class="like-btn"><span class="ico">' + ICONS.heart + '</span><span class="like-count"></span></button>' +
      '  <button class="comment-btn"><span class="ico">' + ICONS.comment + '</span><span class="comment-count"></span></button>' +
      '  <button class="share-btn"><span class="ico">' + ICONS.share + '</span><span>&nbsp;</span></button>' +
      '</div>';

    el.querySelector('.sh-label').textContent = L.swipeNext;
    el.querySelector('.title').textContent = game.title;
    el.querySelector('.author').textContent = '@' + game.author;
    el.querySelector('.plays').textContent = '▶ ' + game.plays;
    el.querySelector('.like-count').textContent = game.likes;
    el.querySelector('.comment-count').textContent = game.comments;
    if (game.liked) el.querySelector('.like-btn').classList.add('liked');

    el.querySelector('.like-btn').addEventListener('click', function () { toggleLike(index); });
    el.querySelector('.comment-btn').addEventListener('click', function () { openComments(index); });
    el.querySelector('.share-btn').addEventListener('click', function () { share(game); });
    // broken game: tap the error to reload it
    el.querySelector('.load-error').addEventListener('click', function () {
      destroyFrame(index);
      ensureFrame(index);
      if (index === activeIndex) { maybeGo(index); armWatchdog(index); }
    });

    feedEl.appendChild(el);
    observer.observe(el);
    return {
      el: el,
      game: game,
      iframe: null,
      ready: false,
      goSent: false,
      mode: null,          // 'record' | 'replay'
      seed: 0,
      recording: null,     // fetched replay data
      recFetch: null,
      session: null,       // record session {events, lastVt, saved}
      viewCounted: false,
    };
  }

  /* ---------- feed loading ---------- */
  var feedEndEl = document.getElementById('feedEnd');
  var retryDelay = 2000, retryTimer = null;
  function setFeedStatus(msg, center) {
    feedEndEl.textContent = msg || '';
    feedEndEl.classList.toggle('hidden', !msg);
    feedEndEl.classList.toggle('center', !!center);
  }
  function refreshFeedEnd() {
    if (!slides.length) return;
    setFeedStatus(nextOffset === null && activeIndex === slides.length - 1 ? L.feedEnd : '', false);
  }
  // tapping the status line retries immediately
  feedEndEl.addEventListener('click', function () { loadMore(); });

  function loadMore() {
    if (fetching || nextOffset === null) return Promise.resolve();
    fetching = true;
    clearTimeout(retryTimer);
    if (!slides.length) setFeedStatus(L.loading, true);
    return api('/api/feed?offset=' + nextOffset + '&limit=8').then(function (res) {
      retryDelay = 2000;
      res.games.forEach(function (g) {
        if (games.some(function (x) { return x.id === g.id; })) return;
        var idx = games.length;
        games.push(g);
        slides.push(makeSlide(g, idx));
      });
      nextOffset = res.nextOffset;
      fetching = false;
      if (activeIndex === -1 && slides.length) activate(0);
      else updateWindow();
      refreshFeedEnd();
    }).catch(function () {
      // the free-tier server sleeps and takes ~30-60s to wake, and the
      // service worker keeps the shell working offline — keep retrying
      // instead of leaving a silent black screen
      fetching = false;
      if (!slides.length) setFeedStatus(L.feedRetry, true);
      retryTimer = setTimeout(loadMore, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    });
  }

  /* ---------- iframe lifecycle (preload window) ---------- */
  function ensureFrame(i) {
    var s = slides[i];
    if (!s || s.iframe) return;
    var mode = s.game.hasRecording ? 'replay' : 'record';
    s.mode = mode;
    s.seed = mode === 'record' ? ((Math.random() * 0x7fffffff) | 0) : 0;
    var src = '/game/' + s.game.id + '?mode=' + mode + (mode === 'record' ? '&seed=' + s.seed : '');
    var iframe = document.createElement('iframe');
    // No allow-same-origin: uploaded game code runs in an opaque origin and
    // cannot touch our page, cookies or localStorage.
    iframe.setAttribute('sandbox', 'allow-scripts allow-pointer-lock');
    iframe.setAttribute('allow', 'autoplay');
    iframe.src = src;
    s.el.querySelector('.frame-wrap').appendChild(iframe);
    s.iframe = iframe;
    s.el.classList.toggle('replaying', mode === 'replay');
    if (mode === 'replay' && !s.recFetch) startRecFetch(i);
    if (mode === 'record') {
      s.session = { events: [], lastVt: 0, saved: false, posted: false };
    }
  }

  function startRecFetch(i) {
    var s = slides[i];
    s.recFetch = api('/api/games/' + s.game.id + '/recording').then(function (r) {
      s.recording = r;
      maybeGo(i);
    }).catch(function (err) {
      if (err.status === 404 && s.iframe) {
        // recording vanished (e.g. sample refresh dropped it): this viewer
        // becomes the new first player instead of staring at a spinner
        s.game.hasRecording = false;
        destroyFrame(i);
        ensureFrame(i);
        if (i === activeIndex) maybeGo(i);
      } else {
        // transient failure (sleeping server): keep retrying while visible
        s.recFetch = null;
        setTimeout(function () {
          if (s.iframe && s.mode === 'replay' && !s.recording && !s.recFetch) startRecFetch(i);
        }, 3000);
      }
    });
  }

  function destroyFrame(i) {
    var s = slides[i];
    if (!s || !s.iframe) return;
    if (s.mode === 'record') finishRecording(i);
    s.iframe.remove();
    s.iframe = null;
    s.ready = false;
    s.goSent = false;
    clearTimeout(s.watchdog);
    if (!s.recording) s.recFetch = null; // failed fetch: retry on next visit
    s.el.classList.remove('game-over', 'playing', 'broken');
    s.el.querySelector('.swipe-hint').classList.add('hidden');
    s.el.querySelector('.load-error').classList.add('hidden');
    s.el.querySelector('.spinner').classList.remove('off');
    s.el.querySelector('.badge').classList.add('hidden');
  }

  /* a game that never becomes ready (missing file, crashed script, bad HTML)
     must not leave the viewer on an eternal spinner — show an error and give
     the touch surface back to the feed */
  function markBroken(i) {
    var s = slides[i];
    if (!s || !s.iframe || s.ready) return;
    clearTimeout(s.watchdog);
    s.el.classList.add('broken');
    s.el.querySelector('.spinner').classList.add('off');
    s.el.querySelector('.load-error').classList.remove('hidden');
  }

  function armWatchdog(i) {
    var s = slides[i];
    if (!s || !s.iframe || s.goSent) return;
    clearTimeout(s.watchdog);
    s.watchdog = setTimeout(function () {
      if (i !== activeIndex || !s.iframe || s.goSent) return;
      if (!s.ready) markBroken(i);
      else armWatchdog(i); // ready but still waiting on the recording fetch
    }, 12000);
  }

  function updateWindow() {
    if (activeIndex < 0) return;
    var lo = Math.max(0, activeIndex - KEEP_BEHIND);
    var hi = Math.min(slides.length - 1, activeIndex + PRELOAD_AHEAD);
    for (var i = 0; i < slides.length; i++) {
      if (i >= lo && i <= hi) ensureFrame(i);
      else destroyFrame(i);
    }
    // fetch more games before the user reaches the end
    if (games.length - activeIndex <= PRELOAD_AHEAD + 2) loadMore();
  }

  /* ---------- activation ---------- */
  function maybeGo(i) {
    var s = slides[i];
    if (!s || i !== activeIndex || !s.iframe || !s.ready || s.goSent) return;
    if (s.mode === 'replay' && !s.recording) return; // wait for recording fetch
    var msg = { gsns: 'go' };
    if (s.mode === 'replay') msg.events = s.recording.events;
    s.iframe.contentWindow.postMessage(msg, '*');
    s.goSent = true;
    s.el.querySelector('.spinner').classList.add('off');
    var badge = s.el.querySelector('.badge');
    badge.classList.remove('hidden', 'live', 'replay');
    if (s.mode === 'record') {
      badge.classList.add('live');
      badge.textContent = L.live;
      // while the run is live the game owns the whole screen: fade the action
      // rail out of the way so its buttons don't steal taps from the game
      s.el.classList.add('playing');
      s.session.startedAt = Date.now();
      s.session.capTimer = setTimeout(function () { finishRecording(i); }, MAX_RECORD_MS + 2000);
    } else {
      badge.classList.add('replay');
      var spd = (s.recording && s.recording.speed) || 2;
      badge.textContent = L.replay + ' ' + spd + L.replayNote;
    }
    if (!s.viewCounted) {
      s.viewCounted = true;
      api('/api/games/' + s.game.id + '/view', { method: 'POST' }).catch(function () { });
    }
  }

  function activate(i) {
    if (i === activeIndex) return;
    var prev = activeIndex;
    activeIndex = i;
    if (prev >= 0 && slides[prev] && slides[prev].mode === 'record') finishRecording(prev);
    updateWindow();
    maybeGo(i);
    armWatchdog(i);
    refreshFeedEnd();
  }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting && en.intersectionRatio >= 0.6) {
        activate(parseInt(en.target.dataset.index, 10));
      }
    });
  }, { root: feedEl, threshold: [0.6] });

  /* ---------- recording collection & save ---------- */
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object' || !d.gsns) return;
    var i = findSlideByWindow(e.source);
    if (i < 0) return;
    var s = slides[i];
    if (d.gsns === 'ready') {
      s.ready = true;
      clearTimeout(s.watchdog);
      s.el.classList.remove('broken');
      s.el.querySelector('.load-error').classList.add('hidden');
      if (i === activeIndex) { maybeGo(i); armWatchdog(i); }
      else if (s.el.querySelector('.spinner')) {
        // preloaded & frozen: hide spinner so swiping in feels instant
        s.el.querySelector('.spinner').classList.add('off');
      }
    } else if (d.gsns === 'unavailable') {
      // the server told us the game file is gone — no point waiting
      markBroken(i);
    } else if (d.gsns === 'events' && s.session && !s.session.saved) {
      if (Array.isArray(d.events)) s.session.events = s.session.events.concat(d.events);
      if (typeof d.vt === 'number') s.session.lastVt = Math.max(s.session.lastVt, d.vt);
      if (d.final && i !== activeIndex) finishRecording(i);
    } else if (d.gsns === 'replay-done') {
      // loop the replay like a video: reload the (cached) iframe
      if (i === activeIndex && s.mode === 'replay') {
        setTimeout(function () {
          if (i !== activeIndex || !s.iframe) return;
          s.ready = false; s.goSent = false;
          s.iframe.src = s.iframe.src;
        }, 800);
      }
    } else if (d.gsns === 'game-over') {
      // the game announced its end screen: save the run now and let the
      // player swipe on (the iframe stops eating pointer events)
      if (s.mode === 'record' && !s.el.classList.contains('game-over')) {
        s.el.classList.add('game-over');
        s.el.classList.remove('playing');
        s.el.querySelector('.swipe-hint').classList.remove('hidden');
        finishRecording(i);
      }
    } else if (d.gsns === 'swipe') {
      // flick relayed by the harness (pointer events never reach us while
      // the player is inside the sandboxed iframe)
      if (i === activeIndex && s.mode === 'record') {
        scrollToSlide(activeIndex + (d.dir === 'down' ? -1 : 1));
      }
    }
  });

  function scrollToSlide(i) {
    if (i < 0 || i >= slides.length) return;
    slides[i].el.scrollIntoView({ behavior: 'smooth' });
  }

  /* ---------- swipe assist (replay / game-over / broken slides) ----------
     When the iframe is click-through the feed scrolls natively, but a swipe
     shorter than half a screen snaps back. Apply the same forgiving gesture
     rules as in-game swipes so every slide feels identical. Touch events keep
     firing during native scrolling (pointer events get cancelled), so use
     touchstart/touchend. */
  var tsY = 0, tsX = 0, tsT = 0, tsSlide = -1;
  feedEl.addEventListener('touchstart', function (e) {
    tsY = e.touches[0].clientY; tsX = e.touches[0].clientX;
    tsT = Date.now(); tsSlide = activeIndex;
  }, { passive: true });
  feedEl.addEventListener('touchend', function (e) {
    if (tsSlide < 0 || !e.changedTouches.length) return;
    var start = tsSlide; tsSlide = -1;
    var dt = Date.now() - tsT;
    var dy = e.changedTouches[0].clientY - tsY;
    var dx = e.changedTouches[0].clientX - tsX;
    var ay = Math.abs(dy);
    var long = dt < 1400 && ay > Math.min(window.innerHeight * 0.22, 240);
    var quick = dt < 500 && ay > 80 && ay / Math.max(dt, 1) > 0.6;
    if ((long || quick) && ay > 1.7 * Math.abs(dx)) {
      scrollToSlide(start + (dy < 0 ? 1 : -1));
    }
  }, { passive: true });

  /* ---------- keyboard + button navigation (desktop) ---------- */
  window.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (!sheet.classList.contains('hidden')) return;
    if (document.querySelector('.modal-backdrop:not(.hidden)')) return;
    var k = e.key;
    if (k === 'ArrowDown' || k === 'PageDown' || k === ' ' || k === 'j') {
      e.preventDefault(); scrollToSlide(activeIndex + 1);
    } else if (k === 'ArrowUp' || k === 'PageUp' || k === 'k') {
      e.preventDefault(); scrollToSlide(activeIndex - 1);
    }
  });
  document.getElementById('navUp').addEventListener('click', function () { scrollToSlide(activeIndex - 1); });
  document.getElementById('navDown').addEventListener('click', function () { scrollToSlide(activeIndex + 1); });

  function findSlideByWindow(w) {
    for (var i = 0; i < slides.length; i++) {
      if (slides[i].iframe && slides[i].iframe.contentWindow === w) return i;
    }
    return -1;
  }

  function finishRecording(i) {
    var s = slides[i];
    if (!s || !s.session || s.session.saved) return;
    var sess = s.session;
    s.el.classList.remove('playing');
    if (sess.capTimer) clearTimeout(sess.capTimer);
    // ask the harness for any buffered events, then post shortly after
    if (s.iframe && s.goSent) {
      try { s.iframe.contentWindow.postMessage({ gsns: 'flush' }, '*'); } catch (e) { }
    }
    sess.saved = true;
    setTimeout(function () { postRecording(i); }, 350);
  }

  // A run is worth keeping only if the player actually played: a single
  // pointerdown right at the end is just the skip-flick (or an accidental
  // tap) and must not lock the game into a do-nothing replay forever.
  function meaningfulInput(events, lastVt) {
    var inputs = events.filter(function (e) { return e.k === 'pointerdown' || e.k === 'keydown'; });
    if (!inputs.length) return false;
    if (inputs.length >= 2) return true;
    var end = Math.max(lastVt || 0, events[events.length - 1].t);
    return end - inputs[0].t > 1500; // one input then kept watching = minimal real play
  }

  function postRecording(i) {
    var s = slides[i];
    var sess = s.session;
    if (!sess || sess.posted) return;
    var events = sess.events;
    var duration = Math.max(sess.lastVt, events.length ? events[events.length - 1].t + 1200 : 0);
    if (!meaningfulInput(events, sess.lastVt) || duration < 1500) { s.session = null; return; }
    sess.posted = true;
    var body = { seed: s.seed, duration: Math.min(duration, MAX_RECORD_MS), events: events };
    api('/api/games/' + s.game.id + '/recording', { method: 'POST', body: body })
      .then(function () {
        s.game.hasRecording = true;
        toast(L.recorded);
      })
      .catch(function (err) {
        if (err.status === 409) s.game.hasRecording = true; // someone beat us to it
      });
  }

  // best-effort save when the tab closes mid-play
  window.addEventListener('pagehide', function () {
    var s = slides[activeIndex];
    if (!s || s.mode !== 'record' || !s.session || s.session.posted) return;
    var events = s.session.events;
    var duration = Math.max(s.session.lastVt, events.length ? events[events.length - 1].t + 1200 : 0);
    if (!meaningfulInput(events, s.session.lastVt) || duration < 1500) return;
    s.session.posted = true;
    var blob = new Blob([JSON.stringify({ seed: s.seed, duration: duration, events: events })], { type: 'application/json' });
    navigator.sendBeacon('/api/games/' + s.game.id + '/recording', blob);
  });

  /* ---------- likes ---------- */
  function toggleLike(i) {
    var s = slides[i];
    var btn = s.el.querySelector('.like-btn');
    var cnt = s.el.querySelector('.like-count');
    api('/api/games/' + s.game.id + '/like', { method: 'POST' }).then(function (r) {
      s.game.liked = r.liked;
      s.game.likes = r.likes;
      btn.classList.toggle('liked', r.liked);
      cnt.textContent = r.likes;
    }).catch(function () { });
  }

  /* ---------- comments ---------- */
  var sheet = document.getElementById('commentSheet');
  var sheetBackdrop = document.getElementById('sheetBackdrop');
  var commentList = document.getElementById('commentList');
  var commentIndex = -1;
  document.getElementById('commentTitle').textContent = L.comments;
  document.getElementById('commentName').placeholder = L.namePlaceholder;
  document.getElementById('commentText').placeholder = L.commentPlaceholder;
  document.getElementById('commentSend').textContent = L.send;

  function openComments(i) {
    commentIndex = i;
    sheet.classList.remove('hidden');
    sheetBackdrop.classList.remove('hidden');
    renderComments([]);
    api('/api/games/' + slides[i].game.id + '/comments').then(function (r) {
      renderComments(r.comments);
    }).catch(function () { });
  }
  function renderComments(items) {
    commentList.innerHTML = '';
    if (!items.length) {
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = L.noComments;
      commentList.appendChild(li);
      return;
    }
    items.forEach(function (c) {
      var li = document.createElement('li');
      var n = document.createElement('div'); n.className = 'cname';
      n.textContent = c.name || 'anonymous';
      var t = document.createElement('div'); t.className = 'ctext';
      t.textContent = c.text;
      li.appendChild(n); li.appendChild(t);
      commentList.appendChild(li);
    });
  }
  sheetBackdrop.addEventListener('click', function () {
    sheet.classList.add('hidden');
    sheetBackdrop.classList.add('hidden');
  });
  document.getElementById('commentForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var text = document.getElementById('commentText').value.trim();
    if (!text || commentIndex < 0) return;
    var name = document.getElementById('commentName').value.trim();
    var s = slides[commentIndex];
    api('/api/games/' + s.game.id + '/comments', { method: 'POST', body: { text: text, name: name } })
      .then(function () {
        document.getElementById('commentText').value = '';
        s.game.comments++;
        s.el.querySelector('.comment-count').textContent = s.game.comments;
        return api('/api/games/' + s.game.id + '/comments');
      })
      .then(function (r) { renderComments(r.comments); })
      .catch(function () { toast(L.uploadFailed); });
  });

  /* ---------- share ---------- */
  function share(game) {
    var url = location.origin + '/?g=' + game.id;
    if (navigator.share) {
      navigator.share({ title: game.title + ' — GSNS', url: url }).catch(function () { });
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () { toast(L.copied); });
    }
  }

  /* ---------- upload ---------- */
  var uploadModal = document.getElementById('uploadModal');
  var uploadBtn = document.getElementById('uploadBtn');
  uploadBtn.textContent = '+ ' + L.upload;
  document.getElementById('upTitle').textContent = L.upTitle;
  document.getElementById('upTitleLabel').textContent = L.upTitleLabel;
  document.getElementById('upAuthorLabel').textContent = L.upAuthorLabel;
  document.getElementById('upFileLabel').textContent = L.upFileLabel;
  document.getElementById('upHint').textContent = L.upHint;
  document.getElementById('upCancel').textContent = L.cancel;
  document.getElementById('upSubmit').textContent = L.submit;

  uploadBtn.addEventListener('click', function () { uploadModal.classList.remove('hidden'); });
  document.getElementById('upCancel').addEventListener('click', function () { uploadModal.classList.add('hidden'); });
  document.getElementById('upSubmit').addEventListener('click', function () {
    var title = document.getElementById('upGameTitle').value.trim();
    var author = document.getElementById('upAuthor').value.trim();
    var fileInput = document.getElementById('upFile');
    if (!title) return toast(L.needTitle);
    var file = fileInput.files && fileInput.files[0];
    if (!file) return toast(L.needFile);
    if (file.size > 2 * 1024 * 1024) return toast(L.fileTooBig);
    var btn = document.getElementById('upSubmit');
    btn.disabled = true;
    btn.textContent = L.uploading;
    file.text().then(function (html) {
      return api('/api/games', { method: 'POST', body: { title: title, author: author, html: html } });
    }).then(function () {
      uploadModal.classList.add('hidden');
      btn.disabled = false;
      btn.textContent = L.submit;
      document.getElementById('upGameTitle').value = '';
      fileInput.value = '';
      toast(L.uploaded);
      resetFeed();
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = L.submit;
      // show the server's reason (e.g. "html too large") so failures are debuggable
      var why = err && err.message && !/^\d+$/.test(err.message) ? ' (' + err.message + ')' : '';
      toast(L.uploadFailed + why);
    });
  });

  function resetFeed() {
    for (var i = 0; i < slides.length; i++) destroyFrame(i);
    slides.forEach(function (s) { observer.unobserve(s.el); });
    feedEl.innerHTML = '';
    games = []; slides = []; activeIndex = -1; nextOffset = 0; fetching = false;
    clearTimeout(retryTimer); retryDelay = 2000; setFeedStatus('', false);
    feedEl.scrollTop = 0;
    loadMore();
  }

  /* ---------- onboarding ---------- */
  var onboard = document.getElementById('onboard');
  document.getElementById('obTitle').textContent = L.obTitle;
  document.getElementById('obBody').textContent = L.obBody;
  document.getElementById('obClose').textContent = L.obClose;
  if (!localStorage.getItem('gsns_onboarded')) onboard.classList.remove('hidden');
  document.getElementById('obClose').addEventListener('click', function () {
    localStorage.setItem('gsns_onboarded', '1');
    onboard.classList.add('hidden');
  });

  /* ---------- PWA: service worker + install (⑧) ---------- */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () { });
  }
  var installBtn = document.getElementById('installBtn');
  installBtn.textContent = L.install;
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.classList.remove('hidden');
  });
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (isIOS && !standalone) installBtn.classList.remove('hidden');
  installBtn.addEventListener('click', function () {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function () { deferredPrompt = null; installBtn.classList.add('hidden'); });
    } else if (isIOS) {
      document.getElementById('iosInstall').classList.remove('hidden');
    }
  });
  document.getElementById('iosTitle').textContent = L.iosTitle;
  document.getElementById('iosBody').textContent = L.iosBody;
  document.getElementById('iosClose').textContent = L.close;
  document.getElementById('iosClose').addEventListener('click', function () {
    document.getElementById('iosInstall').classList.add('hidden');
  });

  /* ---------- boot (deep link: /?g=123) ---------- */
  var deepId = new URLSearchParams(location.search).get('g');
  if (deepId) {
    api('/api/games/' + deepId).then(function (g) {
      games.push(g);
      slides.push(makeSlide(g, 0));
      activate(0);
      return loadMore();
    }).catch(function () { return loadMore(); });
  } else {
    loadMore();
  }
})();
