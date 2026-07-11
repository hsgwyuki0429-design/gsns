/*
 * GSNS game harness — injected at the top of every uploaded game.
 *
 * Responsibilities:
 *  - Deterministic environment: seeded Math.random, virtual clock
 *    (performance.now / Date / rAF / timers), so a recorded play can be
 *    reproduced later at a different speed.
 *  - Freeze: the game loads but its clock stays at 0 until the parent
 *    sends "go" (enables preloading the next games without them running).
 *  - record mode: captures pointer/keyboard input and streams it to the
 *    parent page via postMessage.
 *  - replay mode: receives a recording from the parent and re-dispatches
 *    the events on the virtual timeline (which runs at `speed`x).
 */
(function () {
  'use strict';
  var cfg = window.__GSNS__ || { mode: 'record', seed: 1, speed: 1 };
  var MODE = cfg.mode === 'replay' ? 'replay' : 'record';
  var SPEED = MODE === 'replay' ? Math.min(Math.max(+cfg.speed || 2, 0.25), 8) : 1;

  /* ---------- seeded RNG ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  Math.random = mulberry32((cfg.seed >>> 0) || 1);

  /* ---------- virtual clock (frozen until "go") ---------- */
  var realNow = performance.now.bind(performance);
  var realRAF = window.requestAnimationFrame.bind(window);
  var realCAF = window.cancelAnimationFrame.bind(window);
  var realSetInterval = window.setInterval.bind(window);
  var started = false, startReal = 0;
  function vnow() { return started ? (realNow() - startReal) * SPEED : 0; }

  performance.now = function () { return vnow(); };
  var EPOCH = 1700000000000;
  var RealDate = Date;
  window.Date = class Date extends RealDate {
    constructor() {
      if (arguments.length === 0) super(EPOCH + Math.floor(vnow()));
      else super(...arguments);
    }
    static now() { return EPOCH + Math.floor(vnow()); }
  };

  /* rAF: callbacks held while frozen, receive virtual timestamps */
  var rafSeq = 1, rafQueue = [];
  window.requestAnimationFrame = function (cb) {
    var id = rafSeq++;
    rafQueue.push({ id: id, cb: cb });
    schedulePump();
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    for (var i = 0; i < rafQueue.length; i++) {
      if (rafQueue[i].id === id) { rafQueue.splice(i, 1); return; }
    }
  };
  var pumpScheduled = false;
  function schedulePump() {
    if (pumpScheduled) return;
    pumpScheduled = true;
    realRAF(function () {
      pumpScheduled = false;
      pumpTimers();
      if (!started) { if (rafQueue.length) schedulePump(); return; }
      if (!rafQueue.length) return;
      var batch = rafQueue; rafQueue = [];
      var t = vnow();
      for (var i = 0; i < batch.length; i++) {
        try { batch[i].cb(t); } catch (e) { console.error(e); }
      }
      if (rafQueue.length) schedulePump();
    });
  }

  /* timers on the virtual timeline */
  var timerSeq = 1, timers = [];
  window.setTimeout = function (fn, delay) {
    var args = Array.prototype.slice.call(arguments, 2);
    var id = timerSeq++;
    timers.push({ id: id, due: vnow() + (+delay || 0), fn: fn, args: args, interval: 0 });
    return id;
  };
  window.setInterval = function (fn, delay) {
    var args = Array.prototype.slice.call(arguments, 2);
    var id = timerSeq++;
    var iv = Math.max(+delay || 0, 4);
    timers.push({ id: id, due: vnow() + iv, fn: fn, args: args, interval: iv });
    return id;
  };
  window.clearTimeout = window.clearInterval = function (id) {
    for (var i = 0; i < timers.length; i++) {
      if (timers[i].id === id) { timers.splice(i, 1); return; }
    }
  };
  function pumpTimers() {
    if (!started || !timers.length) return;
    var t = vnow();
    var due = [];
    for (var i = 0; i < timers.length; i++) if (timers[i].due <= t) due.push(timers[i]);
    due.sort(function (a, b) { return a.due - b.due; });
    for (var j = 0; j < due.length; j++) {
      var tm = due[j];
      var idx = timers.indexOf(tm);
      if (idx === -1) continue; // cleared by an earlier callback
      if (tm.interval) tm.due = Math.max(tm.due + tm.interval, t - tm.interval);
      else timers.splice(idx, 1);
      try { typeof tm.fn === 'function' ? tm.fn.apply(null, tm.args) : eval(String(tm.fn)); }
      catch (e) { console.error(e); }
    }
  }
  // backup pump so timers still fire when the game schedules no rAF
  realSetInterval(function () { pumpTimers(); if (rafQueue.length) schedulePump(); }, 33);

  /* ---------- recording ---------- */
  var recorded = [];
  var lastMoveT = -100;
  var recDone = false;

  function pushEvent(o) {
    if (recDone || recorded.length >= 30000) return;
    if (o.t > 90000) { recDone = true; return; }
    recorded.push(o);
  }
  function onPointer(e) {
    if (!started || !e.isTrusted) return;
    var t = vnow();
    if (e.type === 'pointermove') {
      if (t - lastMoveT < 12) return;
      lastMoveT = t;
    }
    pushEvent({
      t: Math.round(t), k: e.type,
      x: +(e.clientX / window.innerWidth).toFixed(4),
      y: +(e.clientY / window.innerHeight).toFixed(4),
      b: e.button || 0,
    });
  }
  function onKey(e) {
    if (!started || !e.isTrusted) return;
    pushEvent({ t: Math.round(vnow()), k: e.type, key: String(e.key).slice(0, 24), c: String(e.code).slice(0, 24) });
  }
  if (MODE === 'record') {
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach(function (type) {
      window.addEventListener(type, onPointer, { capture: true, passive: true });
    });
    window.addEventListener('keydown', onKey, { capture: true, passive: true });
    window.addEventListener('keyup', onKey, { capture: true, passive: true });
    // fast, long, mostly-vertical flicks double as feed navigation: the
    // parent page can't see pointer events inside the sandboxed iframe,
    // so relay the gesture (it is still recorded as game input too)
    var swX = 0, swY = 0, swT = 0;
    window.addEventListener('pointerdown', function (e) {
      if (!e.isTrusted) return;
      swX = e.clientX; swY = e.clientY; swT = realNow();
    }, { capture: true, passive: true });
    window.addEventListener('pointerup', function (e) {
      if (!e.isTrusted || !swT) return;
      var dt = realNow() - swT, dx = e.clientX - swX, dy = e.clientY - swY;
      swT = 0;
      var ay = Math.abs(dy);
      // either a long stroke (slow deliberate drags count too), or a
      // short-but-fast flick, both mostly vertical
      var long = dt < 1400 && ay > Math.min(window.innerHeight * 0.22, 240);
      var quick = dt < 500 && ay > 80 && ay / Math.max(dt, 1) > 0.6;
      if ((long || quick) && ay > 1.7 * Math.abs(dx)) {
        try { window.parent.postMessage({ gsns: 'swipe', dir: dy < 0 ? 'up' : 'down' }, '*'); } catch (err) { }
      }
    }, { capture: true, passive: true });
    // desktop: the iframe swallows wheel events, so relay scroll intent
    var wheelAcc = 0, wheelT = 0, wheelNavT = 0;
    window.addEventListener('wheel', function (e) {
      var now = realNow();
      if (now - wheelT > 400) wheelAcc = 0;
      wheelT = now;
      wheelAcc += e.deltaY;
      if (now - wheelNavT < 700 || Math.abs(wheelAcc) < 140) return;
      wheelNavT = now;
      var dir = wheelAcc > 0 ? 'up' : 'down'; // scroll down = swipe up = next
      wheelAcc = 0;
      try { window.parent.postMessage({ gsns: 'swipe', dir: dir }, '*'); } catch (err) { }
    }, { capture: true, passive: true });
    realSetInterval(function () { flush(false); }, 1200);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush(true);
    });
    window.addEventListener('pagehide', function () { flush(true); });
  }
  function flush(final) {
    if (MODE !== 'record') return;
    if (!recorded.length && !final) return;
    var batch = recorded; recorded = [];
    try {
      window.parent.postMessage({ gsns: 'events', events: batch, vt: Math.round(vnow()), final: !!final }, '*');
    } catch (e) { /* parent gone */ }
  }

  /* ---------- replay ---------- */
  var replayEvents = null, ri = 0, pointerIsDown = false;

  function dispatchPointer(ev) {
    var cx = (ev.x || 0) * window.innerWidth;
    var cy = (ev.y || 0) * window.innerHeight;
    var target = document.elementFromPoint(cx, cy) || document.body || document.documentElement;
    if (!target) return;
    var down = ev.k === 'pointerdown' || (ev.k === 'pointermove' && pointerIsDown);
    var base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: cx, clientY: cy, screenX: cx, screenY: cy,
      button: ev.b || 0, buttons: down ? 1 : 0,
    };
    try {
      target.dispatchEvent(new PointerEvent(ev.k, Object.assign({}, base, {
        pointerId: 1, pointerType: 'touch', isPrimary: true,
      })));
    } catch (e) { }
    var touchType = { pointerdown: 'touchstart', pointermove: 'touchmove', pointerup: 'touchend', pointercancel: 'touchcancel' }[ev.k];
    if (touchType && (ev.k !== 'pointermove' || pointerIsDown)) {
      try {
        var touch = new Touch({ identifier: 1, target: target, clientX: cx, clientY: cy, pageX: cx, pageY: cy, screenX: cx, screenY: cy });
        var live = touchType === 'touchend' || touchType === 'touchcancel' ? [] : [touch];
        target.dispatchEvent(new TouchEvent(touchType, {
          bubbles: true, cancelable: true, composed: true, view: window,
          touches: live, targetTouches: live, changedTouches: [touch],
        }));
      } catch (e) { }
    }
    var mouseType = { pointerdown: 'mousedown', pointermove: 'mousemove', pointerup: 'mouseup' }[ev.k];
    if (mouseType) {
      try { target.dispatchEvent(new MouseEvent(mouseType, base)); } catch (e) { }
    }
    if (ev.k === 'pointerdown') pointerIsDown = true;
    if (ev.k === 'pointerup' || ev.k === 'pointercancel') {
      pointerIsDown = false;
      if (ev.k === 'pointerup') {
        try { target.dispatchEvent(new MouseEvent('click', base)); } catch (e) { }
      }
    }
  }
  function dispatchOne(ev) {
    if (ev.k === 'keydown' || ev.k === 'keyup') {
      try {
        var ke = new KeyboardEvent(ev.k, { key: ev.key || '', code: ev.c || '', bubbles: true, cancelable: true, composed: true });
        (document.activeElement || document.body || document).dispatchEvent(ke);
      } catch (e) { }
      return;
    }
    dispatchPointer(ev);
  }
  function replayStep() {
    if (!replayEvents) return;
    var t = vnow();
    while (ri < replayEvents.length && replayEvents[ri].t <= t) {
      try { dispatchOne(replayEvents[ri]); } catch (e) { }
      ri++;
    }
    if (ri < replayEvents.length) realRAF(replayStep);
    else {
      try { window.parent.postMessage({ gsns: 'replay-done', vt: Math.round(vnow()) }, '*'); } catch (e) { }
    }
  }

  /* ---------- parent protocol ---------- */
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.gsns === 'go' && !started) {
      started = true;
      startReal = realNow();
      if (rafQueue.length) schedulePump();
      if (MODE === 'replay') {
        replayEvents = Array.isArray(d.events) ? d.events : [];
        ri = 0;
        realRAF(replayStep);
      }
    } else if (d.gsns === 'flush') {
      flush(true);
    }
  });

  function announceReady() {
    try { window.parent.postMessage({ gsns: 'ready', mode: MODE }, '*'); } catch (e) { }
  }
  if (document.readyState === 'complete') announceReady();
  else window.addEventListener('load', announceReady);

  /* keep the page from scrolling/bouncing under the game */
  window.addEventListener('DOMContentLoaded', function () {
    try {
      var st = document.createElement('style');
      st.textContent = 'html,body{overscroll-behavior:none;}';
      document.head.appendChild(st);
    } catch (e) { }
  });
})();
