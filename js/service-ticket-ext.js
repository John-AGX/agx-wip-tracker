// Work-order detail extensions — window.p86StExt.
//
// js/service-tickets.js draws the ticket list and the open work order. Every
// other office module that adds to that screen (review and approve, notice
// banners, flags, uploads, change orders, print) registers here instead of
// being called by name from inside it, so those modules can ship and change
// without editing the host file.
//
//   p86StExt.register('ticket-flags', { order: 30, rowBadges: fn, detailSections: fn, ... });
//
// Registry methods:
//   register(name, ext)   adds ext, or replaces the one already under that
//                         name (a replacement keeps its place in the list).
//                         ext.order defaults to 100. Returns true when taken.
//   unregister(name)      removes it. Returns true when there was one.
//   list()                [{ name, order, ext }] sorted by order, then by
//                         registration.
//   collect(hook, ...a)   every result that is not null/undefined, in list
//                         order. detailSections returns an array per module,
//                         so the host concatenates those.
//   first(hook, ...a)     the first result that is not undefined (a null
//                         counts — confirmMove resolving to null is a cancel).
//   html(hook, ...a)      string results joined, in list order.
//
// Each hook call runs in its own try/catch: a module that throws is logged as
// console.warn('[p86StExt] <name>.<hook>') and skipped, and the rest still
// run. A broken banner must never cost the office the work order under it.
//
// Hook names, slots and the ctx object are listed in the Work Orders 1.29
// shared contracts (5.2). This file knows nothing about them: it only calls
// whatever hook it is asked for, on whichever modules define it.
(function () {
  'use strict';

  function createRegistry() {
    var entries = [];
    var seq = 0;

    function warn(name, hook, err) {
      try {
        if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
          console.warn('[p86StExt] ' + name + '.' + hook, err);
        }
      } catch (e) { /* logging must not throw either */ }
    }

    function orderOf(ext) {
      var o = ext && ext.order;
      return (typeof o === 'number' && isFinite(o)) ? o : 100;
    }

    function indexOf(name) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].name === name) return i;
      }
      return -1;
    }

    function sorted() {
      return entries.slice().sort(function (a, b) {
        return (a.order - b.order) || (a.seq - b.seq);
      });
    }

    function register(name, ext) {
      if (typeof name !== 'string' || !name || !ext || typeof ext !== 'object') {
        warn(String(name), 'register', new Error('register needs a name and an extension object'));
        return false;
      }
      var at = indexOf(name);
      var entry = { name: name, ext: ext, order: orderOf(ext), seq: at === -1 ? ++seq : entries[at].seq };
      if (at === -1) entries.push(entry);
      else entries[at] = entry;
      return true;
    }

    function unregister(name) {
      var at = indexOf(name);
      if (at === -1) return false;
      entries.splice(at, 1);
      return true;
    }

    function list() {
      return sorted().map(function (e) {
        return { name: e.name, order: e.order, ext: e.ext };
      });
    }

    // Calls hook on every module that defines it. visit(result) returns true
    // to stop early.
    function each(hook, args, visit) {
      var rows = sorted();
      for (var i = 0; i < rows.length; i++) {
        var e = rows[i];
        var fn = e.ext && e.ext[hook];
        if (typeof fn !== 'function') continue;
        var out;
        try {
          out = fn.apply(e.ext, args);
        } catch (err) {
          warn(e.name, hook, err);
          continue;
        }
        if (visit(out) === true) return;
      }
    }

    function restArgs(argsObj) {
      return Array.prototype.slice.call(argsObj, 1);
    }

    function collect(hook) {
      var results = [];
      each(hook, restArgs(arguments), function (out) {
        if (out != null) results.push(out);
      });
      return results;
    }

    function first(hook) {
      var found;
      each(hook, restArgs(arguments), function (out) {
        if (out !== undefined) { found = out; return true; }
      });
      return found;
    }

    function html(hook) {
      var parts = [];
      each(hook, restArgs(arguments), function (out) {
        if (typeof out === 'string') parts.push(out);
      });
      return parts.join('');
    }

    return {
      register: register,
      unregister: unregister,
      list: list,
      collect: collect,
      first: first,
      html: html
    };
  }

  if (typeof window !== 'undefined') {
    // Loaded twice (a cache-bust reload of one tag): keep the registry that
    // modules already registered with.
    if (!window.p86StExt || typeof window.p86StExt.register !== 'function') {
      window.p86StExt = createRegistry();
    }
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createRegistry: createRegistry };
  }
})();
