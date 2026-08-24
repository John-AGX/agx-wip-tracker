// Project 86 — Cloudflare Email Worker (inbound email dropbox).
//
// Cloudflare Email Routing delivers a redirected/forwarded email to this
// Worker. Unlike Resend's metadata-only webhook, the Worker gets the
// ENTIRE raw MIME message in hand — we parse it (postal-mime) into clean
// fields and POST them to the app, which does the user-match, threading,
// entity-linking, storage, and triage.
//
// Env (set via wrangler / the CF dashboard):
//   P86_INBOUND_URL     — https://project86.net/api/email-inbox/inbound-cf
//   P86_INBOUND_SECRET  — shared secret (a Worker SECRET, not a plain var);
//                         must equal the app's INBOUND_CF_SECRET.
//
// Delivery semantics: on a transient app failure (non-2xx) we THROW, which
// tells Cloudflare the delivery failed so the sending server retries — mail
// is never silently dropped. On success (any 2xx: ok / ignored / deduped)
// we return normally and the message is consumed.

import PostalMime from 'postal-mime';

export default {
  async email(message, env, ctx) {
    // Full raw bytes — the source of truth for both parsing and dedupe.
    const buf = await new Response(message.raw).arrayBuffer();

    // Dedupe key = SHA-256 of the ENVELOPE RECIPIENT + raw message. The
    // recipient prefix makes the key PER-DELIVERY: Email Routing fires the
    // Worker once per recipient with byte-identical raw, so hashing the
    // raw alone would collide across two dropbox recipients of the same
    // message (and the server would drop the second). Stable across true
    // retries (same recipient + same bytes), distinct per recipient.
    const enc = new TextEncoder();
    const prefix = enc.encode((message.to || '') + '\n');
    const rawBytes = new Uint8Array(buf);
    const combined = new Uint8Array(prefix.length + rawBytes.length);
    combined.set(prefix, 0);
    combined.set(rawBytes, prefix.length);
    const digest = await crypto.subtle.digest('SHA-256', combined);
    const dedupeKey = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

    let parsed = {};
    // postal-mime v2 documented API: static PostalMime.parse(...), which
    // accepts the ArrayBuffer directly.
    try { parsed = await PostalMime.parse(buf); } catch (e) { /* fall back to envelope-only */ }

    // A postal-mime Address is either a Mailbox {name, address} or a group
    // {name, group:[Mailbox…]}. Flatten groups to their first member so a
    // group From/To still yields a usable address.
    const mailbox = (a) => (a && a.address) ? a : (a && Array.isArray(a.group) && a.group[0]) || null;
    const addrStr = (a) => { const m = mailbox(a); return m ? (m.name ? `${m.name} <${m.address}>` : m.address) : ''; };
    const addrList = (arr) => (arr || []).map(addrStr).filter(Boolean);

    // Attachments — postal-mime hands us each file's bytes. Base64 them into
    // the forwarded JSON so the app can store them; before this, attachments
    // were parsed here and then dropped (never left the Worker). Guard the
    // total so one huge mail can't blow the app's inbound body cap: skip any
    // file over PER_FILE, and stop packing once TOTAL_CAP is reached. Skipped
    // files still forward as metadata so the app can record that they existed.
    const PER_FILE = 18 * 1024 * 1024;   // 18 MB per file
    const TOTAL_CAP = 22 * 1024 * 1024;  // 22 MB per message (base64 adds ~33%)
    const toBase64 = (u8) => {
      let out = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < u8.length; i += CHUNK) {
        out += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
      }
      return btoa(out);
    };
    const attachments = [];
    let packed = 0;
    for (const a of (parsed.attachments || [])) {
      // Skip inline/embedded images — signature logos and cid: images that the
      // HTML body references, not files a person forwarded. The hub doesn't
      // render cid: images anyway, so carrying them would just clutter every
      // message with a phantom attachment. Only real attachments are forwarded.
      if (a && a.disposition === 'inline') continue;
      const raw = a && a.content;
      let bytes;
      if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
      else if (raw && raw.buffer instanceof ArrayBuffer) bytes = new Uint8Array(raw.buffer);
      else if (typeof raw === 'string') bytes = enc.encode(raw);
      else continue;
      const meta = {
        filename: a.filename || 'attachment',
        mimeType: a.mimeType || 'application/octet-stream',
        size: bytes.length,
        contentId: a.contentId || null,
      };
      if (bytes.length > PER_FILE || packed + bytes.length > TOTAL_CAP) {
        meta.skipped = true;
      } else {
        meta.contentBase64 = toBase64(bytes);
        packed += bytes.length;
      }
      attachments.push(meta);
    }

    const payload = {
      // Envelope RCPT — the address Email Routing actually routed on; this
      // is the dropbox address even when the mail was REDIRECTED (headers
      // still show the original To). This is how the app finds the owner.
      envelopeTo: [message.to],
      from: addrStr(parsed.from) || message.from || '',
      to: addrList(parsed.to),
      cc: addrList(parsed.cc),
      subject: parsed.subject || '',
      text: parsed.text || '',
      html: parsed.html || '',
      messageId: parsed.messageId || '',
      inReplyTo: parsed.inReplyTo || '',
      references: parsed.references || '',
      dedupeKey,
      attachments,
    };

    let resp;
    try {
      resp = await fetch(env.P86_INBOUND_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-P86-Inbound-Secret': env.P86_INBOUND_SECRET || '',
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      // Network error reaching the app — transient; let the sender retry.
      throw new Error('inbound POST failed: ' + (e && e.message));
    }
    if (!resp.ok) {
      // Any non-2xx (auth/config/5xx) — throw so the delivery is retried
      // rather than silently lost. Persistent failures surface as delayed
      // bounces to the redirecting mailbox (visible), not silent drops.
      throw new Error('inbound rejected: HTTP ' + resp.status);
    }
    // 2xx (ok / ignored / deduped) — consume the message.
  },
};
