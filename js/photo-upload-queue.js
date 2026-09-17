// Photo upload queue — window.p86PhotoQueue.
//
// One upload engine for work-order photos, shared by the office (through
// js/work-order-uploads.js) and the crew link. The crew page may not load app
// code, so service-ticket-share.html carries a COPY of the block between the
// two marker comments below, and a parity test keeps the copies identical.
// That block is therefore plain ES5 and touches no app globals: only
// document, window, navigator, URL, Image, Blob/File/FileReader, setTimeout,
// AbortController and Promise, each checked before use.
//
//   HEIC_MESSAGE             the refusal for a HEIC photo this browser can't open
//   uploadIdFor(file, key)   deterministic idempotency key for the server
//   prepareImage(file)       shrink to 2000 px JPEG, EXIF kept, or the original
//   spliceExif(orig, next)   copy the camera's EXIF into a re-encoded JPEG
//   createQueue({ send(item, signal), onChange(item, q), onIdle(q) })
//                            -> { add, retry, discard, items, summary, busy, unsettled }
//   statusText(summary)      the status line both pages show
//
// Behaviour of the queue, in short: one upload at a time across the page;
// every attempt has its own timeout; a network failure retries after 3 s and
// 15 s and then waits for Retry; a 429 pauses everything for as long as the
// server says; a link or work order closed to writes refuses the rest; a
// failure never stops the photos behind it.
(function () {
  'use strict';

  /* photo-queue core: begin */
  function photoQueueCore() {
    var HEIC_MESSAGE = "This photo is in HEIC format (High efficiency), which can't be opened here yet. Use Take photo, or set your camera to save photos as JPEG, then add it again.";
    var MB = 1024 * 1024;
    var MAX_EDGE = 2000;
    var SMALL_JPEG_BYTES = 1.5 * MB;
    var KEEP_ORIGINAL_MAX = 15 * MB;
    var EXIF_READ_BYTES = 256 * 1024;
    var JPEG_QUALITY = 0.85;
    var WORK_TIMEOUT_MS = 20000;
    var ATTEMPT_BASE_MS = 45000;
    var ATTEMPT_PER_MB_MS = 30000;
    var ATTEMPT_MAX_MS = 240000;
    var BACKOFF_MS = [3000, 15000];
    var MAX_ATTEMPTS = 3;
    var OFFLINE_RECHECK_MS = 15000;
    var PAUSE_DEFAULT_S = 30;
    var PAUSE_MIN_S = 1;
    var PAUSE_MAX_S = 300;

    function warn(what, err) {
      try {
        if (typeof console !== 'undefined' && console && typeof console.warn === 'function') console.warn('photo queue: ' + what, err);
      } catch (e) { /* nothing */ }
    }

    // ── Upload ids ────────────────────────────────────────────────────────
    // FNV-1a, 32 bit, written with shifts so it needs no Math.imul.
    function fnv1a(str, basis) {
      var h = basis >>> 0;
      for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
      }
      return h >>> 0;
    }

    function hex8(n) {
      return ('0000000' + (n >>> 0).toString(16)).slice(-8);
    }

    // The same file picked again for the same target gives the same id, so a
    // retry, or a re-pick after a reload, is recognised by the server. A new
    // camera shot always differs in size or lastModified.
    function uploadIdFor(file, targetKey) {
      var f = file || {};
      var s = String(targetKey == null ? '' : targetKey) + '|' + String(f.name || '') + '|' +
        String(f.size == null ? '' : f.size) + '|' + String(f.lastModified == null ? '' : f.lastModified) + '|' +
        String(f.type || '');
      return 'u' + hex8(fnv1a(s, 0x811c9dc5)) + hex8(fnv1a(s, 0x050c5d1f));
    }

    // ── Bytes and EXIF ────────────────────────────────────────────────────
    function toBytes(buf) {
      if (!buf || typeof Uint8Array === 'undefined') return null;
      if (buf instanceof Uint8Array) return buf;
      if (Object.prototype.toString.call(buf) === '[object ArrayBuffer]') return new Uint8Array(buf);
      if (buf.buffer && typeof buf.byteLength === 'number') return new Uint8Array(buf.buffer, buf.byteOffset || 0, buf.byteLength);
      return null;
    }

    // The APP1 "Exif\0\0" segment of a JPEG: { start, end, truncated } or null.
    function findExifSegment(b) {
      if (!b || b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
      var i = 2;
      while (i + 4 <= b.length) {
        if (b[i] !== 0xFF) return null;
        var marker = b[i + 1];
        if (marker === 0xFF) { i++; continue; }
        if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) { i += 2; continue; }
        if (marker === 0xDA || marker === 0xD9) return null;
        var len = (b[i + 2] << 8) | b[i + 3];
        if (len < 2) return null;
        var end = i + 2 + len;
        if (marker === 0xE1 && len >= 8 && i + 10 <= b.length &&
            b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66 &&
            b[i + 8] === 0 && b[i + 9] === 0) {
          return { start: i, end: end, truncated: end > b.length };
        }
        if (end > b.length) return null;
        i = end;
      }
      return null;
    }

    // Rewrites IFD0 Orientation to 1 inside a copied APP1 segment. The pixels
    // were drawn upright already, so a kept 6 or 8 would turn them again.
    // False when the TIFF header or IFD0 does not fit the segment.
    function resetOrientation(seg) {
      var t = 10;
      var little;
      if (seg.length < t + 8) return false;
      if (seg[t] === 0x49 && seg[t + 1] === 0x49) little = true;
      else if (seg[t] === 0x4D && seg[t + 1] === 0x4D) little = false;
      else return false;
      var u16 = function (p) {
        return little ? (seg[p] | (seg[p + 1] << 8)) : ((seg[p] << 8) | seg[p + 1]);
      };
      var u32 = function (p) {
        return little
          ? (seg[p] | (seg[p + 1] << 8) | (seg[p + 2] << 16)) + seg[p + 3] * 16777216
          : seg[p] * 16777216 + ((seg[p + 1] << 16) | (seg[p + 2] << 8) | seg[p + 3]);
      };
      if (u16(t + 2) !== 42) return false;
      var ifd = t + u32(t + 4);
      if (ifd + 2 > seg.length) return false;
      var count = u16(ifd);
      if (ifd + 2 + count * 12 > seg.length) return false;
      for (var k = 0; k < count; k++) {
        var e = ifd + 2 + k * 12;
        if (u16(e) === 0x0112) {
          if (little) { seg[e + 8] = 1; seg[e + 9] = 0; } else { seg[e + 8] = 0; seg[e + 9] = 1; }
          return true;
        }
      }
      return true;
    }

    // origBuf: the camera's JPEG (or its first bytes). newBuf: the re-encoded
    // JPEG. Returns the new JPEG with the camera's EXIF right after SOI and
    // Orientation reset to 1, or null when that cannot be done.
    function spliceExif(origBuf, newBuf) {
      var o = toBytes(origBuf);
      var n = toBytes(newBuf);
      if (!o || !n || n.length < 4 || n[0] !== 0xFF || n[1] !== 0xD8) return null;
      var seg = findExifSegment(o);
      if (!seg || seg.truncated) return null;
      var app1 = new Uint8Array(seg.end - seg.start);
      app1.set(o.subarray(seg.start, seg.end));
      if (!resetOrientation(app1)) return null;
      var out = new Uint8Array(n.length + app1.length);
      out[0] = 0xFF;
      out[1] = 0xD8;
      out.set(app1, 2);
      out.set(n.subarray(2), 2 + app1.length);
      return out;
    }

    // ── Preparing a photo ─────────────────────────────────────────────────
    function isHeic(file) {
      var type = String((file && file.type) || '');
      var name = String((file && file.name) || '');
      return /^image\/hei[cf]/i.test(type) || /\.(heic|heif)$/i.test(name);
    }

    var decodeSupport = null;
    // URL.createObjectURL is tested FIRST, so a page or test without it never
    // touches a canvas at all.
    function canDecode() {
      if (decodeSupport !== null) return decodeSupport;
      decodeSupport = false;
      try {
        if (typeof URL === 'undefined' || !URL || typeof URL.createObjectURL !== 'function') return decodeSupport;
        if (typeof document === 'undefined' || !document || typeof Image === 'undefined') return decodeSupport;
        var c = document.createElement('canvas');
        decodeSupport = !!(c && typeof c.getContext === 'function' && typeof c.toBlob === 'function' && c.getContext('2d'));
      } catch (e) {
        decodeSupport = false;
      }
      return decodeSupport;
    }

    // Runs start(ok, bad) and settles once, or rejects after ms.
    function timed(ms, start) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          reject(new Error('timed out'));
        }, ms);
        var ok = function (v) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(v);
        };
        var bad = function (e) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        };
        try { start(ok, bad); } catch (e) { bad(e); }
      });
    }

    function revokeUrl(url) {
      if (!url) return;
      try { URL.revokeObjectURL(url); } catch (e) { /* nothing */ }
    }

    function decodeImage(file) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      return timed(WORK_TIMEOUT_MS, function (ok, bad) {
        img.onload = function () { ok(img); };
        img.onerror = function () { bad(new Error('could not decode')); };
        img.src = url;
        if (typeof img.decode === 'function') {
          try { img.decode().then(function () { ok(img); }, function () { /* onerror decides */ }); } catch (e) { /* onload decides */ }
        }
      }).then(function (loaded) {
        revokeUrl(url);
        return loaded;
      }, function (err) {
        revokeUrl(url);
        throw err;
      });
    }

    function encodeJpeg(canvas) {
      return timed(WORK_TIMEOUT_MS, function (ok, bad) {
        canvas.toBlob(function (blob) {
          if (blob) ok(blob);
          else bad(new Error('could not encode'));
        }, 'image/jpeg', JPEG_QUALITY);
      });
    }

    function readBytes(blob) {
      if (blob && typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
      return new Promise(function (resolve, reject) {
        if (typeof FileReader === 'undefined') { reject(new Error('cannot read the photo')); return; }
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { reject(fr.error || new Error('cannot read the photo')); };
        fr.readAsArrayBuffer(blob);
      });
    }

    function namedJpeg(parts, name) {
      try {
        if (typeof File === 'function') return new File(parts, name, { type: 'image/jpeg' });
      } catch (e) { /* old browser: a Blob below */ }
      var b = new Blob(parts, { type: 'image/jpeg' });
      try { b.name = name; } catch (e2) { /* nothing */ }
      return b;
    }

    function jpegName(name) {
      var base = String(name || '').replace(/\.[^.\/\\]*$/, '');
      return (base || 'photo') + '.jpg';
    }

    // Resolves { blob, name, type, shrunk }. Rejects { permanent:true, message }
    // only for a HEIC photo this browser cannot turn into a JPEG.
    function prepareImage(file) {
      if (!file) return Promise.reject({ permanent: true, message: 'There was no photo to send.' });
      var type = String(file.type || '');
      var name = String(file.name || 'photo');
      var heic = isHeic(file);
      var isJpeg = /^image\/(jpeg|jpg|pjpeg)$/i.test(type);
      var original = function () { return { blob: file, name: name, type: type, shrunk: false }; };
      var refusal = function () { return { permanent: true, message: HEIC_MESSAGE }; };
      if ((!/^image\//i.test(type) && !heic) || /^image\/(gif|svg)/i.test(type)) return Promise.resolve(original());
      if (!canDecode()) return heic ? Promise.reject(refusal()) : Promise.resolve(original());
      var outName = jpegName(name);
      var shrunk = function (blob) {
        var named = (blob && blob.name === outName) ? blob : namedJpeg([blob], outName);
        return { blob: named, name: outName, type: 'image/jpeg', shrunk: true };
      };
      return decodeImage(file).then(function (img) {
        var w = img.naturalWidth || img.width || 0;
        var h = img.naturalHeight || img.height || 0;
        if (!w || !h) throw new Error('could not decode');
        var longest = Math.max(w, h);
        if (!heic && isJpeg && longest <= MAX_EDGE && file.size <= SMALL_JPEG_BYTES) return null;
        var scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1;
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        return encodeJpeg(canvas);
      }).then(function (jpeg) {
        if (!jpeg) return original();
        if (!heic && jpeg.size >= file.size) return original();
        if (!isJpeg) return shrunk(jpeg);
        var head = typeof file.slice === 'function' ? file.slice(0, EXIF_READ_BYTES) : file;
        var keepOriginal = function () {
          return file.size > KEEP_ORIGINAL_MAX ? shrunk(jpeg) : original();
        };
        return readBytes(head).then(function (origBuf) {
          var orig = toBytes(origBuf);
          if (!findExifSegment(orig)) return shrunk(jpeg);
          return readBytes(jpeg).then(function (nextBuf) {
            var spliced = spliceExif(orig, nextBuf);
            return spliced ? shrunk(namedJpeg([spliced], outName)) : keepOriginal();
          });
        }).then(null, keepOriginal);
      }, function () {
        if (heic) throw refusal();
        return original();
      });
    }

    // ── The queue ─────────────────────────────────────────────────────────
    function statusOf(err) {
      var s = Number(err && err.status);
      return (isFinite(s) && s > 0) ? s : 0;
    }

    function retryAfterOf(err) {
      if (!err) return null;
      if (err.retryAfter != null) return err.retryAfter;
      if (err.data && err.data.retryAfter != null) return err.data.retryAfter;
      return null;
    }

    function pauseSeconds(err) {
      var s = Number(retryAfterOf(err));
      if (!(s > 0)) s = PAUSE_DEFAULT_S;
      return Math.max(PAUSE_MIN_S, Math.min(PAUSE_MAX_S, s));
    }

    function messageOf(err) {
      if (err && err.message) return String(err.message);
      if (typeof err === 'string' && err) return err;
      return 'The upload failed.';
    }

    function isRetryable(status, err) {
      if (!status) return true;
      if (err && (err.name === 'TypeError' || err.name === 'AbortError')) return true;
      return status === 408 || status >= 500;
    }

    function isOffline() {
      return typeof navigator !== 'undefined' && !!navigator && navigator.onLine === false;
    }

    function toList(files) {
      var out = [];
      if (!files) return out;
      if (typeof files.length === 'number' && typeof files.size !== 'number') {
        for (var i = 0; i < files.length; i++) out.push(files[i]);
      } else {
        out.push(files);
      }
      return out;
    }

    function createQueue(opts) {
      opts = opts || {};
      var send = opts.send;
      var onChange = opts.onChange;
      var onIdle = opts.onIdle;
      var prepare = typeof opts.prepare === 'function' ? opts.prepare : prepareImage;
      var all = [];
      var nextId = 0;
      var active = null;
      var pausedUntil = 0;
      var offline = false;
      var offlineTimer = null;
      var wakeTimer = null;
      var wakeAt = 0;
      var skippedByKey = {};
      var wasBusy = false;
      var queue = null;

      function keyOf(target) {
        return String(target && typeof target === 'object' ? target.key : target);
      }

      function ofKey(key) {
        if (key == null) return all.slice();
        var k = String(key);
        var out = [];
        for (var i = 0; i < all.length; i++) if (all[i].key === k) out.push(all[i]);
        return out;
      }

      function inState(list, states) {
        var out = [];
        for (var i = 0; i < list.length; i++) if (states.indexOf(list[i].state) !== -1) out.push(list[i]);
        return out;
      }

      function busy() {
        return inState(all, ['preparing', 'waiting', 'uploading']).length > 0;
      }

      function unsettled() {
        return busy() || inState(all, ['failed']).length > 0;
      }

      function previewFor(blob) {
        try {
          if (typeof URL !== 'undefined' && URL && typeof URL.createObjectURL === 'function') return URL.createObjectURL(blob);
        } catch (e) { /* no preview */ }
        return null;
      }

      function dropPreview(item) {
        revokeUrl(item.previewUrl);
        item.previewUrl = null;
      }

      // Tells the page about each changed item, then whether the queue has
      // gone quiet.
      function touch(changed) {
        for (var i = 0; i < changed.length; i++) {
          if (typeof onChange === 'function') {
            try { onChange(changed[i], queue); } catch (e) { warn('onChange failed', e); }
          }
        }
        if (busy()) {
          wasBusy = true;
        } else if (wasBusy) {
          wasBusy = false;
          if (typeof onIdle === 'function') {
            try { onIdle(queue); } catch (e2) { warn('onIdle failed', e2); }
          }
        }
      }

      function kick() {
        Promise.resolve().then(pump);
      }

      function schedule(at) {
        if (wakeTimer && wakeAt <= at) return;
        if (wakeTimer) clearTimeout(wakeTimer);
        wakeAt = at;
        wakeTimer = setTimeout(function () {
          wakeTimer = null;
          wakeAt = 0;
          pump();
        }, Math.max(0, at - Date.now()));
      }

      function goOffline() {
        if (!offline) {
          offline = true;
          touch(inState(all, ['waiting']));
        }
        if (!offlineTimer) {
          offlineTimer = setTimeout(function () {
            offlineTimer = null;
            pump();
          }, OFFLINE_RECHECK_MS);
        }
      }

      function backOnline() {
        if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
        if (!offline) return;
        offline = false;
        touch(inState(all, ['waiting']));
      }

      function pump() {
        if (active) return;
        var now = Date.now();
        if (pausedUntil > now) { schedule(pausedUntil); return; }
        if (pausedUntil) {
          pausedUntil = 0;
          touch(inState(all, ['waiting']));
        }
        var next = null;
        var soonest = 0;
        for (var i = 0; i < all.length; i++) {
          var it = all[i];
          if (it.state !== 'waiting') continue;
          if (it.retryAt <= now) { next = it; break; }
          if (!soonest || it.retryAt < soonest) soonest = it.retryAt;
        }
        if (!next) {
          if (soonest) schedule(soonest);
          touch([]);
          return;
        }
        if (isOffline()) { goOffline(); return; }
        backOnline();
        run(next);
      }

      function run(item) {
        active = item;
        if (item.prepared) { attempt(item); return; }
        item.state = 'preparing';
        touch([item]);
        var prepared;
        try { prepared = Promise.resolve(prepare(item.file)); } catch (e) { prepared = Promise.reject(e); }
        prepared.then(function (res) {
          if (active !== item) return;
          item.prepared = true;
          if (res && res.blob) {
            item.blob = res.blob;
            item.name = res.name || item.name;
            item.type = res.type || item.type;
            item.shrunk = !!res.shrunk;
          } else {
            item.blob = item.file;
          }
          item.previewUrl = previewFor(item.blob);
          attempt(item);
        }, function (err) {
          if (active !== item) return;
          item.prepared = true;
          if (err && err.permanent) {
            item.state = 'refused';
            item.error = messageOf(err);
            active = null;
            touch([item]);
            kick();
            return;
          }
          // Could not shrink it: the photo goes as it is, and the server decides.
          item.blob = item.file;
          item.shrunk = false;
          item.previewUrl = previewFor(item.file);
          attempt(item);
        });
      }

      function attempt(item) {
        item.state = 'uploading';
        item.attempts++;
        item.retryAt = 0;
        touch([item]);
        var ctrl = null;
        try { ctrl = typeof AbortController === 'function' ? new AbortController() : null; } catch (e) { ctrl = null; }
        var size = (item.blob && item.blob.size) || 0;
        var ms = Math.min(ATTEMPT_MAX_MS, ATTEMPT_BASE_MS + ATTEMPT_PER_MB_MS * Math.ceil(size / MB));
        var settled = false;
        var timer = null;
        var landed = function (json) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          active = null;
          item.state = 'done';
          item.error = null;
          item.result = json == null ? null : json;
          touch([item]);
          kick();
        };
        var rejected = function (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          active = null;
          failed(item, err);
        };
        timer = setTimeout(function () {
          if (ctrl) { try { ctrl.abort(); } catch (e) { /* nothing */ } }
          var err = new Error('The upload timed out.');
          err.name = 'AbortError';
          err.timedOut = true;
          rejected(err);
        }, ms);
        var sent;
        try { sent = send(item, ctrl ? ctrl.signal : undefined); } catch (e) { rejected(e); return; }
        Promise.resolve(sent).then(landed, rejected);
      }

      function failed(item, err) {
        var status = statusOf(err);
        var message = messageOf(err);
        var now = Date.now();
        if (status === 429 || (status === 503 && retryAfterOf(err) != null)) {
          // The server asked everyone to slow down: nothing goes until then,
          // and this attempt does not count against the photo.
          item.attempts--;
          item.state = 'waiting';
          pausedUntil = now + pauseSeconds(err) * 1000;
          touch(inState(all, ['waiting']));
          kick();
          return;
        }
        if (status === 422 && item.shrunk && !item.triedOriginal) {
          // The server could not read our re-encoded copy: send the original once.
          item.triedOriginal = true;
          item.attempts--;
          item.blob = item.file;
          item.name = item.file.name || item.name;
          item.type = item.file.type || item.type;
          item.shrunk = false;
          item.state = 'waiting';
          touch([item]);
          kick();
          return;
        }
        if (isRetryable(status, err)) {
          item.error = message;
          if (isOffline()) {
            item.attempts--;
            item.state = 'waiting';
          } else if (item.attempts >= MAX_ATTEMPTS) {
            item.state = 'failed';
          } else {
            item.state = 'waiting';
            item.retryAt = now + BACKOFF_MS[item.attempts - 1];
          }
          touch([item]);
          kick();
          return;
        }
        item.state = 'refused';
        item.error = message;
        var refusedNow = [item];
        if (status === 403 || status === 409 || status === 410) {
          // The link or the work order is closed to writes: the photos still
          // waiting would get the same answer, so they are told now.
          for (var i = 0; i < all.length; i++) {
            if (all[i] !== item && all[i].state === 'waiting') {
              all[i].state = 'refused';
              all[i].error = message;
              refusedNow.push(all[i]);
            }
          }
        }
        touch(refusedNow);
        kick();
      }

      function add(files, target) {
        var t = (target && typeof target === 'object') ? target : { key: target };
        var key = keyOf(t);
        var list = toList(files);
        var mine = ofKey(key);
        var seen = {};
        var i;
        for (i = 0; i < mine.length; i++) {
          if (mine[i].state !== 'refused') seen[mine[i].uploadId] = true;
        }
        var fresh = [];
        var skipped = 0;
        for (i = 0; i < list.length; i++) {
          var file = list[i];
          if (!file) continue;
          var uploadId = uploadIdFor(file, key);
          if (seen[uploadId]) { skipped++; continue; }
          seen[uploadId] = true;
          fresh.push({ file: file, uploadId: uploadId });
        }
        skippedByKey[key] = skipped;
        if (fresh.length && !inState(mine, ['preparing', 'waiting', 'uploading', 'failed']).length) {
          // A new batch for this target: its counts start again.
          var keep = [];
          for (i = 0; i < all.length; i++) {
            var old = all[i];
            if (old.key === key && (old.state === 'done' || old.state === 'refused')) dropPreview(old);
            else keep.push(old);
          }
          all = keep;
        }
        var added = [];
        for (i = 0; i < fresh.length; i++) {
          var item = {
            id: 'pq' + (++nextId),
            uploadId: fresh[i].uploadId,
            target: t,
            key: key,
            file: fresh[i].file,
            blob: null,
            name: String(fresh[i].file.name || 'photo'),
            type: String(fresh[i].file.type || ''),
            state: 'waiting',
            attempts: 0,
            error: null,
            retryAt: 0,
            previewUrl: null,
            result: null,
            shrunk: false,
            prepared: false,
            triedOriginal: false
          };
          all.push(item);
          added.push(item);
        }
        if (added.length) {
          touch(added);
          kick();
        }
        return { added: added.length, skipped: skipped };
      }

      // Failed photos go back in line with the SAME upload id, so a photo that
      // did reach the server before the connection dropped is not added twice.
      function retry(targetKey) {
        var hit = [];
        for (var i = 0; i < all.length; i++) {
          var it = all[i];
          if (it.state !== 'failed') continue;
          if (targetKey != null && it.key !== String(targetKey)) continue;
          it.state = 'waiting';
          it.attempts = 0;
          it.retryAt = 0;
          it.error = null;
          hit.push(it);
        }
        if (hit.length) {
          touch(hit);
          kick();
        }
        return hit.length;
      }

      function discard(targetKey) {
        var keep = [];
        var gone = [];
        for (var i = 0; i < all.length; i++) {
          var it = all[i];
          var match = targetKey == null || it.key === String(targetKey);
          if (match && (it.state === 'failed' || it.state === 'refused')) gone.push(it);
          else keep.push(it);
        }
        all = keep;
        for (var j = 0; j < gone.length; j++) {
          dropPreview(gone[j]);
          gone[j].state = 'discarded';
        }
        if (gone.length) touch(gone);
        return gone.length;
      }

      function summary(targetKey) {
        var list = ofKey(targetKey);
        var now = Date.now();
        var s = {
          total: list.length, done: 0, active: 0, waiting: 0, retrying: 0, failed: 0, refused: 0,
          pausedUntil: pausedUntil > now ? pausedUntil : 0,
          offline: offline,
          index: 0,
          refusals: [],
          skipped: 0
        };
        var activeAt = 0;
        var waitingAt = 0;
        for (var i = 0; i < list.length; i++) {
          var it = list[i];
          if (it.state === 'done') s.done++;
          else if (it.state === 'preparing' || it.state === 'uploading') { s.active++; if (!activeAt) activeAt = i + 1; }
          else if (it.state === 'waiting') { s.waiting++; if (it.attempts > 0) s.retrying++; if (!waitingAt) waitingAt = i + 1; }
          else if (it.state === 'failed') s.failed++;
          else if (it.state === 'refused') {
            s.refused++;
            s.refusals.push({ name: String((it.file && it.file.name) || it.name), message: it.error || '' });
          }
        }
        s.index = activeAt || waitingAt || s.total;
        if (targetKey == null) {
          for (var k in skippedByKey) {
            if (Object.prototype.hasOwnProperty.call(skippedByKey, k)) s.skipped += skippedByKey[k];
          }
        } else {
          s.skipped = skippedByKey[String(targetKey)] || 0;
        }
        return s;
      }

      function wake() {
        retry();
        kick();
      }

      if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
        window.addEventListener('online', function () {
          backOnline();
          wake();
        });
      }
      if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') wake();
        });
      }

      queue = {
        add: add,
        retry: retry,
        discard: discard,
        items: function (targetKey) { return ofKey(targetKey); },
        summary: summary,
        busy: busy,
        unsettled: unsettled
      };
      return queue;
    }

    // ── Wording ───────────────────────────────────────────────────────────
    function statusText(s, nouns) {
      if (!s) return '';
      var one = (nouns && nouns.one) || 'photo';
      var many = (nouns && nouns.many) || 'photos';
      var count = function (n) { return n + ' ' + (n === 1 ? one : many); };
      var lines = [];
      var pending = (s.active || 0) + (s.waiting || 0);
      var now = Date.now();
      if (pending > 0 && s.offline) {
        lines.push('No signal. ' + count(pending) + ' waiting — ' + (pending === 1 ? "it'll" : "they'll") + " send when you're back online.");
      } else if (pending > 0 && s.pausedUntil > now) {
        lines.push('The server is busy. Trying again in ' + Math.max(1, Math.ceil((s.pausedUntil - now) / 1000)) + ' s…');
      } else if (pending > 0) {
        lines.push('Uploading ' + s.index + ' of ' + s.total + '…' + (s.retrying ? ' ' + s.retrying + ' will retry' : ''));
      } else if (s.total > 0) {
        var bad = (s.failed || 0) + (s.refused || 0);
        if (!bad) lines.push(s.done === 1 ? one.charAt(0).toUpperCase() + one.slice(1) + ' added.' : count(s.done) + ' added.');
        else lines.push(s.done + ' of ' + s.total + " added. " + bad + " didn't go through.");
      }
      var refusals = s.refusals || [];
      for (var i = 0; i < refusals.length && i < 2; i++) {
        lines.push(refusals[i].name + " wasn't sent: " + refusals[i].message);
      }
      if (s.skipped) lines.push('Skipped ' + count(s.skipped) + ' already added.');
      return lines.join('\n');
    }

    return {
      HEIC_MESSAGE: HEIC_MESSAGE,
      uploadIdFor: uploadIdFor,
      prepareImage: prepareImage,
      spliceExif: spliceExif,
      createQueue: createQueue,
      statusText: statusText
    };
  }
  /* photo-queue core: end */

  var core = photoQueueCore();
  if (typeof window !== 'undefined' && window) window.p86PhotoQueue = core;
  if (typeof module !== 'undefined' && module && module.exports) module.exports = core;
})();
