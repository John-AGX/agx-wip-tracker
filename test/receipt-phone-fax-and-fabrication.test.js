// TWO NUMBERS THAT ARE NOT THE BRANCH, WEARING THE MARKER THAT SAYS THEY ARE.
//
// Store capture classifies a phone as branch / toll_free / premium and puts a
// green "read the same on N receipts" marker on a corroborated branch line.
// Two kinds of wrong number were still earning that marker, and the reason is
// the same reason the 1-800 case earned it: CORROBORATION AND CORRECTNESS ARE
// DIFFERENT QUESTIONS, and a number that is constant per branch corroborates
// perfectly whether or not it is the number anyone wants.
//
//   FAX.  "FAX: (407) 282-3401" read twice rendered BYTE-IDENTICAL to the
//   branch's voice line, green marker and tel: link included. A fax number is
//   constant per branch, printed on the same header, so it corroborates just
//   as fast. The word FAX died on normalizePhone's first line — `\D+` — and
//   nothing downstream could recover it, because NOTHING IN THE NUMBERING PLAN
//   SEPARATES A FAX FROM A VOICE LINE. There is no NPA for it. The word is the
//   only evidence there has ever been.
//
//   EXTENSION SPLICE.  "282-3400 x407" -> digits 2823400407 -> "(282) 340-0407"
//   -> classified branch -> dialable -> green. THIS ONE FABRICATES A NUMBER.
//   Receipts routinely print a 7-digit local plus a separate extension, and
//   they print it the same way every visit, so the invention agreed on receipt
//   two. The area code — the part that says which town you are calling — was
//   manufactured out of an extension.
//
// THEY ARE TREATED DIFFERENTLY, AND THE DIFFERENCE IS THE POINT:
//
//   A fax is a REAL NUMBER AT THAT BUSINESS. It is kept, exactly as a
//   toll-free number is kept, and labelled "fax line — not a voice line". It
//   is never green and — unlike toll-free — never a tel: link, because a
//   toll-free number reaches a person and this reaches a modem.
//
//   A spliced extension is a number that MAY BELONG TO A STRANGER. Nobody
//   printed it. It is refused outright: no value, no kind, no link, and the
//   screen says "no phone captured", which is the truth. There is nothing to
//   keep and nothing to label.
//
// THE DEFECT WAS A RENDERING DEFECT — two different facts printing the same
// bytes — so the tests that matter here EXECUTE THE SHIPPED RENDERER and
// compare its output. A classifier that is right while the screen still prints
// one sentence for both fixes nothing John can see. Same idiom, and the same
// reasoning, as test/receipt-store-phone-render.test.js.

const fs = require('fs');
const path = require('path');

const VN = require('../server/services/vendor-name');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'cost-inbox.js'), 'utf8')
  .replace(/\r\n?/g, '\n');

function lift(name) {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('cost-inbox.js no longer defines ' + name);
  let depth = 0;
  let started = false;
  for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
    if (SRC[k] === '{') { depth++; started = true; } else if (SRC[k] === '}') {
      depth--;
      if (started && depth === 0) return SRC.slice(i, k + 1);
    }
  }
  throw new Error('unbalanced braces lifting ' + name);
}

const R = new Function(
  lift('esc') + '\n' + lift('agreementLine') + '\n' + lift('phoneLine') + '\n'
  + 'return { phoneLine: phoneLine, agreementLine: agreementLine };'
)();

// storeReadBlock is the OTHER screen the same two facts land on: the capture
// modal, per receipt, before anything has corroborated. It is lifted whole
// because its `line()` helper is defined inside it.
const B = new Function(
  lift('esc') + '\n' + lift('storeReadBlock') + '\nreturn storeReadBlock;'
)();

// The server's shape. Built from a helper so a payload is never invented.
const agreed = (value, lineType, reads) => ({
  verdict: 'agreed',
  value,
  reads: reads || 2,
  distinct: 1,
  values: [{ value, n: reads || 2 }],
  line_type: lineType,
  dialable: value != null && lineType !== 'premium' && lineType !== 'fax',
});
const nothing = { verdict: 'none', value: null, reads: 0, distinct: 0, values: [] };

const BRANCH_MARKER = 'ci-agree-ok';
const BRANCH_SENTENCE = 'read the same on';

// ─────────────────────────────────────────────────────────────────────────
// THE PARSER — an adversarial set, not the two cases from the report
// ─────────────────────────────────────────────────────────────────────────

describe('normalizePhone: what a receipt can print, and what comes back', () => {
  // Each row is [what the paper says, the number, the kind]. `null` for the
  // number means REFUSED, which on screen is "no phone captured".
  const CASES = [
    // — ordinary branch lines, which must all still work —
    ['(407) 282-3400', '(407) 282-3400', 'branch', 'the counter'],
    ['407-282-3400', '(407) 282-3400', 'branch', 'dashes'],
    ['1 407 555 0119', '(407) 555-0119', 'branch', 'country code, spaces'],
    ['+1 (407) 282-3400', '(407) 282-3400', 'branch', 'written E.164-ish'],
    ['Phone: (407) 282-3400', '(407) 282-3400', 'branch', 'a label in front of it'],
    ['(407) 282-3400 (main)', '(407) 282-3400', 'branch', 'a note after it, with no digits in it'],
    ['(407) 282-\n3400', '(407) 282-3400', 'branch', 'ONE NUMBER WRAPPED ACROSS TWO OCR LINES'],

    // — the fax —
    ['FAX: (407) 282-3401', '(407) 282-3401', 'fax', 'THE FAX, labelled'],
    ['Fax (407) 282-3401', '(407) 282-3401', 'fax', 'fax, no colon'],
    ['facsimile 407-282-3401', '(407) 282-3401', 'fax', 'spelled out'],
    ['FAX 1-800-555-0100', '(800) 555-0100', 'fax', 'a toll-free fax — the MORE cautious answer wins'],
    ['FAX 1-900-555-0100', '(900) 555-0100', 'premium', 'premium outranks the label: being wrong there is a billed call'],

    // — THE LIMIT, STATED. A fax with no label is a phone number and nothing
    //   in the numbering plan says otherwise. This is not a gap left by
    //   accident; it is the boundary of what the evidence can support, and it
    //   is written down so nobody later believes the classifier sees more
    //   than it does.
    ['(407) 282-3401', '(407) 282-3401', 'branch', 'A FAX WITH NO LABEL — indistinguishable, and not claimed otherwise'],

    // — the fabrication —
    ['282-3400 x407', null, null, 'THE SPLICE: a 7-digit local and its extension'],
    ['282-3400 ext. 407', null, null, 'the same, spelled out'],
    ['282-3400 ext 407', null, null, 'the same, no full stop'],
    ['282-3400 x407 (parts)', null, null, 'the same, with a note after it'],
    ['282-3400 #407', null, null, 'the same, with a bare # — which on a receipt means the BRANCH'],
    ['282-3400', null, null, 'a 7-digit local with no extension at all — an area code cannot be guessed'],

    // — and the thing the extension rule GAINS —
    ['(407) 282-3400 x12', '(407) 282-3400', 'branch', 'a real 10-digit number plus an extension: RECOVERED, was refused'],
    ['(407) 282-3400 ext. 12', '(407) 282-3400', 'branch', 'the same, spelled out'],

    // — things on a receipt that are not phone numbers —
    ['$1,234.56', null, null, 'an order total'],
    ['TOTAL 407.28', null, null, 'a labelled total that starts with a real area code'],
    ['1-800-FLOWERS', null, null, 'a vanity string'],
    ['(407) BUY-WOOD', null, null, 'a local vanity string'],
    ['+44 20 7946 0958', null, null, 'international — UK'],
    ['+52 55 1234 5678', null, null, 'international — Mexico'],
    ['+7 495 123 4567', null, null, 'international — Russia'],
    ['(407) 282-3400\nStore #0242', null, null, 'a phone and a branch code, jammed together'],
    ['Ph: 407-282-3400 / Fax: 407-282-3401', null, null, 'BOTH numbers on one line — neither is claimed'],
    ['Store 0242 Phone 407-282-3400', null, null, 'a branch code in front of the number'],

    // — the NANP rules that were already there, kept —
    ['107-555-0119', null, null, 'area code starts with 1'],
    ['407-055-0119', null, null, 'exchange starts with 0'],
    ['911-555-0119', null, null, 'N11 area code'],
    ['40755501', null, null, 'a digit went missing'],
    ['4075550119123', null, null, 'a digit was invented'],
    ['1-800-466-3337', '(800) 466-3337', 'toll_free', 'the chain line, still kept and still labelled'],
    ['(900) 555-1212', '(900) 555-1212', 'premium', 'premium NPA'],
    ['(212) 976-1616', '(212) 976-1616', 'premium', 'premium NXX inside a geographic area code'],
    ['', null, null, 'empty'],
    [null, null, null, 'null'],
  ];

  test.each(CASES)('%j -> %j / %s   (%s)', (raw, num, kind) => {
    expect({ number: VN.normalizePhone(raw), kind: VN.phoneLineType(raw) })
      .toEqual({ number: num, kind });
  });

  test('the fabricated number is not merely rejected — it was never printed', () => {
    // Stated separately because this is the fact that makes a splice worse
    // than a fax. (282) 340-0407 is a DIALABLE NANP NUMBER. It passes every
    // validity rule. It is simply not the number on the paper, and whoever
    // answers it has nothing to do with this branch.
    expect(VN.normalizePhone('(282) 340-0407')).toBe('(282) 340-0407');
    expect(VN.phoneLineType('(282) 340-0407')).toBe('branch');
    expect(VN.normalizePhone('282-3400 x407')).toBeNull();
  });

  test('an extension is stripped, not counted — the two are different repairs', () => {
    // Refusing anything with an "x" in it would have closed the hole and lost
    // every real number that carries an extension. What is refused is the
    // 7-digit REMAINDER, and only that.
    expect(VN.normalizePhone('(407) 282-3400 x407')).toBe('(407) 282-3400');
    expect(VN.normalizePhone('282-3400 x407')).toBeNull();
  });
});

describe('phoneKindFloor: a claim on a request body can only lose you a link', () => {
  // The fax label exists for one instant, in the model's raw output, and is
  // gone from the value the client sends back to be saved. So the kind makes
  // the round trip on the body — and a body is a body.
  test.each([
    ['branch', 'fax', 'fax', 'the honest case: the label the extractor saw'],
    ['branch', 'premium', 'premium', 'a claim that removes a link is always allowed'],
    ['toll_free', 'branch', 'toll_free', 'A CLAIM CAN NEVER CREATE A LINK'],
    ['premium', 'fax', 'premium', 'nor talk a premium number down'],
    ['premium', 'branch', 'premium', 'nor a premium number into a store line'],
    ['fax', 'branch', 'fax', 'nor a fax back into a voice line'],
    ['toll_free', 'fax', 'fax', 'more cautious is honoured'],
    ['branch', 'nonsense', 'branch', 'a kind we do not know is ignored, not stored'],
    ['branch', undefined, 'branch', 'no claim at all'],
    [null, 'fax', null, 'no number, so no kind — a kind cannot conjure one'],
  ])('digits say %s, body claims %s -> %s   (%s)', (derived, claimed, want) => {
    expect(VN.phoneKindFloor(derived, claimed)).toBe(want);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE SCREEN — which is where the defect actually lived
// ─────────────────────────────────────────────────────────────────────────

describe('the Merchants view: a fax does not look like the counter', () => {
  const fax = R.phoneLine(agreed('(407) 282-3401', 'fax', 2));
  const branch = R.phoneLine(agreed('(407) 282-3400', 'branch', 2));

  test('they are not byte-identical', () => {
    expect(fax).not.toBe(branch);
  });

  test('and they differ in the SENTENCE, not merely in the digits', () => {
    // Blank the numbers out. What is left is what the screen CLAIMS about
    // them — and that is the part that used to be identical. A fax number and
    // a voice number at the same branch differ by ONE DIGIT; if the claim were
    // still the same sentence, nothing would have been fixed.
    const claim = (h) => h.replace(/\(\d{3}\) \d{3}-\d{4}/g, '#').replace(/tel:\d+/g, 'tel:#');
    expect(claim(fax)).not.toBe(claim(branch));
  });

  test('the fax never wears the branch-agreement marker, at any count', () => {
    for (const reads of [2, 3, 9, 40]) {
      const html = R.phoneLine(agreed('(407) 282-3401', 'fax', reads));
      expect(html).not.toContain(BRANCH_MARKER);
      expect(html).not.toContain(BRANCH_SENTENCE);
    }
  });

  test('it says on screen what it is, in words anyone can read', () => {
    // Not "line_type: fax". Not a colour. A sentence.
    expect(fax).toContain('fax line — not a voice line');
  });

  test('it is never one tap from dialling a modem', () => {
    expect(fax).not.toContain('href="tel:');
    expect(R.phoneLine({ ...agreed('(407) 282-3401', 'fax', 2), dialable: true }))
      .not.toContain('href="tel:');
  });

  test('but it is KEPT — it is a real number at that branch', () => {
    // The difference from a fabricated number, made visible: this one is on
    // the screen, and John can copy it or fax to it. The spliced one is not on
    // the screen at all, because it does not exist.
    expect(fax).toContain('(407) 282-3401');
  });

  test('the real branch line still wears the marker — it was not simply deleted', () => {
    expect(branch).toContain(BRANCH_MARKER);
    expect(branch).toContain('read the same on 2 receipts');
    expect(branch).toContain('href="tel:4072823400');
  });

  test('all four kinds of line render four different sentences', () => {
    const claim = (h) => h.replace(/\(\d{3}\) \d{3}-\d{4}/g, '#').replace(/tel:\d+/g, 'tel:#');
    const seen = [
      claim(R.phoneLine(agreed('(407) 282-3400', 'branch', 2))),
      claim(R.phoneLine(agreed('(800) 466-3337', 'toll_free', 2))),
      claim(R.phoneLine(agreed('(407) 282-3401', 'fax', 2))),
      claim(R.phoneLine(agreed('(900) 555-1212', 'premium', 2))),
    ];
    expect(new Set(seen).size).toBe(4);
  });
});

describe('the Merchants view: a fabricated number is not on the screen at all', () => {
  test('the splice never reaches the renderer, because it never reaches the row', () => {
    // The whole path, in one assertion: the paper says "282-3400 x407", the
    // validator refuses it, so agreement() has nothing to agree about and the
    // screen prints the honest sentence.
    expect(VN.normalizePhone('282-3400 x407')).toBeNull();
    expect(R.phoneLine(nothing)).toContain('no phone captured');
  });

  test('"no phone captured" is not what a fax looks like, and not what a branch looks like', () => {
    const refused = R.phoneLine(nothing);
    const fax = R.phoneLine(agreed('(407) 282-3401', 'fax', 2));
    const branch = R.phoneLine(agreed('(407) 282-3400', 'branch', 2));
    expect(new Set([refused, fax, branch]).size).toBe(3);
    expect(refused).not.toContain('href="tel:');
    expect(refused).not.toContain(BRANCH_MARKER);
  });
});

describe('the capture modal renders the same two facts, and used to lie about them', () => {
  // storeReadBlock is per-receipt, before anything has corroborated. It printed
  // the phone bare under a note promising it would BECOME TAPPABLE once a
  // second receipt agreed — a promise that is false for a fax and for a
  // premium misread, and it is the same promise that makes the marker on the
  // other screen worth anything.
  const base = { store_number: '0242', store_name: 'THE HOME DEPOT', store_address: null, attachment_id: 'a1' };
  const voice = B({ ...base, store_phone: '(407) 282-3400', store_phone_kind: 'branch' });
  const fax = B({ ...base, store_phone: '(407) 282-3401', store_phone_kind: 'fax' });

  test('a fax and a voice line do not render the same bytes here either', () => {
    const claim = (h) => h.replace(/\(\d{3}\) \d{3}-\d{4}/g, '#');
    expect(claim(fax)).not.toBe(claim(voice));
  });

  test('the caveat is beside the digits, not buried under them', () => {
    // Putting it only in the note below is how the two facts came to look the
    // same in the first place: the row itself said nothing.
    const row = fax.slice(fax.indexOf('Phone'), fax.indexOf('ci-store-note'));
    expect(row).toContain('fax line — not a voice line');
  });

  test('and the note no longer promises a fax will become tappable', () => {
    expect(voice).toContain('It becomes tappable in Merchants');
    expect(fax).not.toContain('It becomes tappable in Merchants');
    expect(fax).toContain('never made tappable');
  });

  test('a premium-rate read gets the same treatment on this screen', () => {
    const prem = B({ ...base, store_phone: '(900) 555-1212', store_phone_kind: 'premium' });
    expect(prem).toContain('premium-rate number — not a store line');
    expect(prem).not.toContain('It becomes tappable in Merchants');
  });

  test('a row written before the column existed still renders exactly as it did', () => {
    // store_phone_kind is NULL on every pre-existing receipt. The old sentence
    // is the fallback, so nothing already on a phone changes appearance.
    const legacy = B({ ...base, store_phone: '(407) 282-3400', store_phone_kind: null });
    expect(legacy).toBe(voice);                      // byte-identical to a known branch line
    expect(legacy).toContain('It becomes tappable in Merchants');
    expect(legacy).not.toContain('ci-unverified');
  });
});

describe('the screen still decides nothing the server was asked to decide', () => {
  const fn = SRC.slice(SRC.indexOf('function phoneLine('), SRC.indexOf('function merchantCard('));

  test('there is still exactly one tel: link in the whole file', () => {
    expect((SRC.match(/href="tel:/g) || []).length).toBe(1);
  });

  test('and it is still behind the server flag', () => {
    expect(fn).toContain('if (p.dialable)');
    expect(fn.indexOf('href="tel:')).toBeGreaterThan(fn.indexOf('if (p.dialable)'));
  });

  test('the fax branch is reached BEFORE the link, not after it', () => {
    // If it came after, the property "a fax is never a link" would depend on
    // the server having set dialable correctly — one fact, two owners.
    expect(fn.indexOf("kind === 'fax'")).toBeGreaterThan(0);
    expect(fn.indexOf("kind === 'fax'")).toBeLessThan(fn.indexOf('if (p.dialable)'));
  });

  test('the client re-derives neither corroboration nor line type', () => {
    expect(fn).not.toMatch(/verdict\s*===\s*'agreed'/);
    expect(fn).not.toMatch(/\b(800|833|844|855|866|877|888|900|976)\b/);
    // and it does not go looking for the word FAX for itself, either
    expect(fn).not.toMatch(/\/.*fax.*\/i/i);
  });
});

describe('none of this can move a number that is money', () => {
  const ROUTES = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'routes', 'receipt-routes.js'), 'utf8'
  ).replace(/\r\n?/g, '\n');

  test('the one statement that turns receipts into job money cannot see the new column', () => {
    // GET /api/receipts/rollup groups on cost_code + is_presale and sums
    // amount. A column it does not name cannot change what it returns — a fact
    // about the statement, not a hope about it.
    const start = ROUTES.indexOf("router.get('/rollup'");
    expect(start).toBeGreaterThan(0);
    const end = ROUTES.indexOf('router.', start + 10);
    const body = ROUTES.slice(start, end > start ? end : start + 4000);
    expect(body).not.toContain('store_phone');
    expect(body).not.toContain('store_phone_kind');
  });

  test('the module the phone rules live in cannot reach money at all', () => {
    // vendor-name.js takes strings and returns strings. It imports nothing, so
    // it has no pool, no route and no row: there is no path from a phone rule
    // to a figure, which is a stronger statement than "it currently does not
    // touch one".
    const VNSRC = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'services', 'vendor-name.js'), 'utf8'
    );
    expect(VNSRC).not.toMatch(/\brequire\s*\(/);
    expect(VNSRC).not.toMatch(/\bpool\b|\bamount\s*[:=]|\bMath\.round\b/);
  });
});
