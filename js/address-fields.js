// ── Structured address fields (street / city / state / zip) ──────────────
// A shared component + helpers so every entity (lead, estimate, job, task,
// client) stores address as separate, FILTERABLE parts instead of one blob.
// Storage on the entity: addr_street, addr_city, addr_state, addr_zip (flat,
// filterable) PLUS the existing formatted `address` string (kept for display
// + back-compat). Reuses window.p86AddressAutocomplete (Google Places) to fill
// all four on pick, and a best-effort parser to backfill legacy freeform ones.
(function () {
  if (window.p86Address) return;

  var US_STATE = /,\s*([A-Za-z]{2})\.?\s*$/;
  var ZIP = /\b(\d{5}(?:-\d{4})?)\s*$/;

  // Best-effort US address parse for backfill / on-the-fly filtering.
  // "123 Main St, Tampa, FL 33601" → {street,city,state,zip}
  function parse(str) {
    var out = { street: '', city: '', state: '', zip: '' };
    str = String(str == null ? '' : str).trim();
    if (!str) return out;
    var m = str.match(ZIP);
    if (m) { out.zip = m[1]; str = str.slice(0, m.index).replace(/[,\s]+$/, ''); }
    m = str.match(US_STATE);
    if (m) { out.state = m[1].toUpperCase(); str = str.slice(0, m.index).replace(/[,\s]+$/, ''); }
    var ci = str.lastIndexOf(',');
    if (ci >= 0) { out.city = str.slice(ci + 1).trim(); out.street = str.slice(0, ci).trim(); }
    else { out.street = str.trim(); }
    return out;
  }

  function format(c) {
    c = c || {};
    var line2 = [c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return [c.street, line2].filter(Boolean).join(', ');
  }

  // Read an entity's components, deriving them from the freeform `address`
  // when the structured fields are empty (legacy rows). Does NOT mutate.
  // Field names match the EXISTING lead model (street_address/city/state/zip)
  // so jobs/estimates/tasks are consistent with leads + convert inherits them.
  function get(obj) {
    obj = obj || {};
    var has = obj.street_address || obj.city || obj.state || obj.zip;
    if (has) return { street: obj.street_address || '', city: obj.city || '', state: obj.state || '', zip: obj.zip || '' };
    return parse(obj.address || obj.jobAddress || obj.projectAddress || '');
  }

  // Populate obj.{street_address,city,state,zip} from its freeform address if
  // missing (idempotent). Lets lists filter legacy records without a migration.
  function ensure(obj) {
    if (!obj) return obj;
    if (obj.street_address || obj.city || obj.state || obj.zip) return obj;
    var c = parse(obj.address || obj.jobAddress || '');
    if (c.street || c.city || c.state || c.zip) {
      obj.street_address = c.street; obj.city = c.city; obj.state = c.state; obj.zip = c.zip;
    }
    return obj;
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }

  // HTML for the four inputs. `container` markup is scoped by a wrapper class so
  // collect()/wire() can find the inputs. Pass opts.disabled for read-only.
  function fieldsHtml(obj, opts) {
    opts = opts || {};
    var c = get(obj);
    var dis = opts.disabled ? ' disabled' : '';
    return '<div class="p86-addr"' + (opts.id ? ' id="' + esc(opts.id) + '"' : '') + '>' +
      '<div class="p86-addr-acm"></div>' +
      '<input class="p86-addr-in" data-addr="street" placeholder="Street address" value="' + esc(c.street) + '"' + dis + '>' +
      '<div class="p86-addr-row">' +
        '<input class="p86-addr-in p86-addr-city" data-addr="city" placeholder="City" value="' + esc(c.city) + '"' + dis + '>' +
        '<input class="p86-addr-in p86-addr-state" data-addr="state" placeholder="State" maxlength="20" value="' + esc(c.state) + '"' + dis + '>' +
        '<input class="p86-addr-in p86-addr-zip" data-addr="zip" placeholder="ZIP" value="' + esc(c.zip) + '"' + dis + '>' +
      '</div>' +
    '</div>';
  }

  // Read the four inputs from a container. Returns {street,city,state,zip,formatted}.
  function collect(container) {
    if (!container) return null;
    var root = container.classList && container.classList.contains('p86-addr') ? container : container.querySelector('.p86-addr');
    if (!root) return null;
    function v(k) { var el = root.querySelector('[data-addr="' + k + '"]'); return el ? el.value.trim() : ''; }
    var c = { street: v('street'), city: v('city'), state: v('state').toUpperCase(), zip: v('zip') };
    c.formatted = format(c);
    return c;
  }

  // Write collected components onto an entity object (+ the formatted string).
  function apply(obj, c) {
    if (!obj || !c) return;
    obj.street_address = c.street; obj.city = c.city; obj.state = c.state; obj.zip = c.zip;
    obj.address = c.formatted;
  }

  // Wire the Places autocomplete into a rendered .p86-addr so a pick fills all
  // four inputs (+ capture lat/lng on the entity when provided). Returns a handle.
  function wire(container, obj, onPick) {
    var root = container && (container.classList && container.classList.contains('p86-addr') ? container : container.querySelector('.p86-addr'));
    if (!root || !window.p86AddressAutocomplete) return null;
    var mount = root.querySelector('.p86-addr-acm'); if (!mount) return null;
    function setIn(k, val) { var el = root.querySelector('[data-addr="' + k + '"]'); if (el && val != null) { el.value = val; try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {} } }
    return window.p86AddressAutocomplete.attach({
      mount: mount,
      placeholder: 'Search address…',
      onPlace: function (r) {
        var cc = r.components || {};
        setIn('street', cc.street_address || '');
        setIn('city', cc.city || '');
        setIn('state', cc.state || '');
        setIn('zip', cc.zip || '');
        if (obj) {
          if (r.lat != null) { obj.geocode_lat = r.lat; obj.lat = r.lat; }
          if (r.lng != null) { obj.geocode_lng = r.lng; obj.lng = r.lng; }
        }
        if (typeof onPick === 'function') onPick(r);
      }
    });
  }

  function injectCss() {
    if (document.getElementById('p86-addr-css')) return;
    var s = document.createElement('style'); s.id = 'p86-addr-css';
    s.textContent =
      '.p86-addr{display:flex;flex-direction:column;gap:7px;}' +
      '.p86-addr-row{display:grid;grid-template-columns:1fr 90px 120px;gap:7px;}' +
      '.p86-addr .p86-addr-in{width:100%;box-sizing:border-box;background:var(--input-bg,rgba(0,0,0,.22));' +
      'border:1px solid var(--border,rgba(255,255,255,.14));border-radius:8px;color:var(--text,#e9ecf5);' +
      'font-size:13px;padding:8px 10px;font-family:inherit;}' +
      '.p86-addr .p86-addr-in:focus{outline:none;border-color:#4f8cff;}' +
      'body.light-mode .p86-addr .p86-addr-in{background:#fff;color:#0f172a;border-color:#d5dae5;}' +
      '.p86-addr-acm{margin-bottom:1px;}' +
      '.p86-addr-acm .p86-addr-ac{width:100%;}' +
      '@media(max-width:520px){.p86-addr-row{grid-template-columns:1fr 70px;}.p86-addr-zip{grid-column:1/-1;}}';
    document.head.appendChild(s);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectCss); else injectCss();

  window.p86Address = { parse: parse, format: format, get: get, ensure: ensure, fieldsHtml: fieldsHtml, collect: collect, apply: apply, wire: wire };
})();
