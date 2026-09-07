// A NUMBER JOHN MIGHT DIAL, AND WHAT THE SCREEN SAYS ABOUT IT.
//
// The wave that shipped store capture validated phone numbers against the
// NORTH AMERICAN NUMBERING PLAN and stopped there. Every rule in
// normalizePhone() is a validity rule; not one is a store-phone rule. So a
// chain's national line and the branch's own counter came out of it
// indistinguishable, and then rendered indistinguishable too:
//
//   WRONG: <a class="ci-store-v" href="tel:8004663337">(800) 466-3337</a>
//          <span class="ci-agree ci-agree-ok">read the same on 2 receipts</span>
//   RIGHT: <a class="ci-store-v" href="tel:4072823400">(407) 282-3400</a>
//          <span class="ci-agree ci-agree-ok">read the same on 2 receipts</span>
//
// Same element, same class, same sentence — and WORSE THAN A TIE, because a
// corporate 1-800 number is printed on every store of a chain, so it agrees
// perfectly and earned the corroboration marker SOONER AND MORE OFTEN than a
// real branch line, which differs per store. The confidence signal was
// promoting the one number that cannot tell you which counter you reached.
//
// THE DEFECT WAS A RENDERING DEFECT: two different facts printing the same
// bytes. So these tests execute the SHIPPED RENDERER and compare its output,
// rather than asserting that a parser returns a different string. A phone
// classifier that is right while the screen still prints one sentence for both
// cases fixes nothing John can see.
//
// The payloads here are written out as the server sends them. That the SERVER
// actually sends this shape is proved separately and end-to-end, over real
// HTTP through the real router, in test/receipt-store-capture.test.js.

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'cost-inbox.js'), 'utf8')
  .replace(/\r\n?/g, '\n');

// Lift a named function out of the shipped file, braces balanced, so these
// tests run the real thing. A copy of the renderer in here would keep passing
// after the renderer regressed, which is the whole failure mode being closed.
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

// The server's shape, built here so a payload is never invented ad hoc.
const agreed = (value, lineType, reads) => ({
  verdict: 'agreed',
  value,
  reads: reads || 2,
  distinct: 1,
  values: [{ value, n: reads || 2 }],
  line_type: lineType,
  dialable: lineType !== 'premium',
});
const once = (value, lineType) => ({
  verdict: 'read_once',
  value,
  reads: 1,
  distinct: 1,
  values: [{ value, n: 1 }],
  line_type: lineType,
  dialable: false,
});

const BRANCH_MARKER = 'ci-agree-ok';
const BRANCH_SENTENCE = 'read the same on';

const TOLL_FREE = ['800', '833', '844', '855', '866', '877', '888'];
const PREMIUM_NUMBERS = ['(900) 555-1212', '(212) 976-1616'];

describe('no number that is not this branch can wear the branch-agreement marker', () => {
  // Stated as a property over EVERY toll-free code at EVERY verdict, because
  // the defect was not one bad number — it was a whole class of number the
  // rules had no opinion about.
  const shapes = [];
  TOLL_FREE.forEach((npa) => {
    const n = '(' + npa + ') 555-0100';
    shapes.push([npa + ' corroborated across two receipts', agreed(n, 'toll_free', 2)]);
    shapes.push([npa + ' corroborated many times over', agreed(n, 'toll_free', 9)]);
    shapes.push([npa + ' seen exactly once', once(n, 'toll_free')]);
  });
  PREMIUM_NUMBERS.forEach((n) => {
    shapes.push([n + ' corroborated', agreed(n, 'premium', 3)]);
    shapes.push([n + ' seen once', once(n, 'premium')]);
  });

  test.each(shapes)('%s never renders the branch marker', (_label, p) => {
    const html = R.phoneLine(p);
    expect(html).not.toContain(BRANCH_MARKER);
    expect(html).not.toContain(BRANCH_SENTENCE);
  });

  test.each(shapes)('%s says on screen what kind of line it is', (_label, p) => {
    // Not knowing what an NPA is must be enough to read this screen.
    expect(R.phoneLine(p)).toMatch(/not this branch|not a store line/);
  });

  test('a real branch line still wears it — the marker was not simply deleted', () => {
    const html = R.phoneLine(agreed('(407) 282-3400', 'branch', 2));
    expect(html).toContain(BRANCH_MARKER);
    expect(html).toContain('read the same on 2 receipts');
  });
});

describe('the two numbers that used to render identically now render differently', () => {
  // The exact pair from the defect report.
  const national = R.phoneLine(agreed('(800) 466-3337', 'toll_free', 2));
  const branch = R.phoneLine(agreed('(407) 282-3400', 'branch', 2));

  test('they are not byte-identical', () => {
    expect(national).not.toBe(branch);
  });

  test('and they differ in the SENTENCE, not merely in the digits', () => {
    // Blank the numbers out. What is left is what the screen CLAIMS about
    // them, and that is the part that used to be identical.
    const claim = (h) => h.replace(/\(\d{3}\) \d{3}-\d{4}/g, '#').replace(/tel:\d+/g, 'tel:#');
    expect(claim(national)).not.toBe(claim(branch));
  });

  test('the national line is still kept, and still reachable', () => {
    // Discarding it would lose real information: some vendors publish nothing
    // else. It is labelled, not thrown away.
    expect(national).toContain('(800) 466-3337');
    expect(national).toContain('href="tel:8004663337"');
  });

  test('a premium-rate number is never one tap from a billed call', () => {
    PREMIUM_NUMBERS.forEach((n) => {
      [agreed(n, 'premium', 5), once(n, 'premium')].forEach((p) => {
        expect(R.phoneLine(p)).not.toContain('href="tel:');
      });
      // still shown, so John can see the bad read and retype it
      expect(R.phoneLine(agreed(n, 'premium', 5))).toContain(n);
    });
  });
});

describe('a number seen once does not look like a number seen twice', () => {
  test.each([
    ['a branch line', 'branch', '(407) 282-3400'],
    ['a national line', 'toll_free', '(800) 466-3337'],
  ])('%s: corroborated and uncorroborated render differently', (_l, kind, n) => {
    expect(R.phoneLine(agreed(n, kind, 2))).not.toBe(R.phoneLine(once(n, kind)));
  });

  test('a single read is never a link, whatever kind of line it is', () => {
    // One reading may have dropped a digit. That is as true of a national
    // number as of a branch one.
    expect(R.phoneLine(once('(407) 282-3400', 'branch'))).not.toContain('href="tel:');
    expect(R.phoneLine(once('(800) 466-3337', 'toll_free'))).not.toContain('href="tel:');
  });

  test('a single read says so, in words, on both kinds of line', () => {
    expect(R.phoneLine(once('(407) 282-3400', 'branch'))).toContain('read once');
    expect(R.phoneLine(once('(800) 466-3337', 'toll_free'))).toContain('read once');
  });

  test('nothing captured still says nothing captured', () => {
    expect(R.phoneLine(null)).toContain('no phone captured');
    expect(R.phoneLine({ verdict: 'none', value: null, reads: 0, values: [] }))
      .toContain('no phone captured');
  });

  test('readings that disagree are never resolved into one confident answer', () => {
    const conflict = {
      verdict: 'conflict',
      value: null,
      reads: 3,
      distinct: 2,
      values: [{ value: '(407) 555-0110', n: 2 }, { value: '(407) 555-0119', n: 1 }],
      line_type: null,
      dialable: false,
    };
    const html = R.phoneLine(conflict);
    expect(html).not.toContain('href="tel:');
    expect(html).not.toContain(BRANCH_MARKER);
    expect(html).toContain('(407) 555-0110');
    expect(html).toContain('(407) 555-0119');
  });
});

describe('the screen never decides for itself what the server was asked to decide', () => {
  const fn = SRC.slice(SRC.indexOf('function phoneLine('), SRC.indexOf('function merchantCard('));

  test('there is still exactly one tel: link in the whole file', () => {
    expect((SRC.match(/href="tel:/g) || []).length).toBe(1);
  });

  test('and it is still behind the server flag', () => {
    expect(fn).toContain('if (p.dialable)');
    expect(fn.indexOf('href="tel:')).toBeGreaterThan(fn.indexOf('if (p.dialable)'));
  });

  test('the client re-derives neither corroboration nor line type', () => {
    // Either re-derivation would create a second definition of "verified",
    // and the client's would be the one on screen.
    expect(fn).not.toMatch(/verdict\s*===\s*'agreed'/);
    expect(fn).not.toMatch(/\b(800|833|844|855|866|877|888|900|976)\b/);
  });
});
