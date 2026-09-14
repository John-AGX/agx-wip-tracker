// Sender identity helpers — server/email-sender.js.
//
// WHAT IS BEING HELD
// Org mail now says who it is from: "AG Exteriors via Project 86"
// <notifications@...>. The org name in that header is TENANT-CONTROLLED free
// text — an org admin can rename the org to anything — so this file pins the
// sanitiser against the ways a display name gets abused:
//   - CR/LF            header injection (a second header, a Bcc)
//   - " \ < > @        breaking out of the quoted display name, or a name
//                      that reads as an address ("billing@chase.com")
//   - U+202E, U+200B   bidi overrides and zero-width characters: text that
//                      renders differently from what it is
//   - "Project 86 ..." a tenant wearing the platform's own name
//   - look-alikes      the same name in Cyrillic/Greek letters, 0/1/3 for
//                      o/l/e, another script's digits, or with hidden filler
//                      letters and blank symbols (U+3164, U+2800) that a
//                      format-character strip keeps; a letter from another
//                      alphabet inside a Latin word, or a symbol, modifier
//                      letter or stray mark standing in for a letter
// and pins the Reply-To validator and the org-predicated address lookups
// (a Reply-To is a users row re-read FRESH and predicated on the org being
// mailed — never the JWT's email, never a platform admin acting as a tenant).

const sender = require('../server/email-sender');

const ENV_FROM = 'Project 86 <notifications@project86.net>';

describe('PLATFORM_NAME', () => {
  test('defaults to Project 86', () => {
    expect(sender.PLATFORM_NAME).toBe('Project 86');
  });
});

describe('parseFromEnv', () => {
  test('"Name <addr>"', () => {
    expect(sender.parseFromEnv(ENV_FROM)).toEqual({ name: 'Project 86', address: 'notifications@project86.net' });
  });
  test('a quoted display name with a comma and an escaped quote', () => {
    expect(sender.parseFromEnv('"Project 86, \\"Inc\\"" <n@p86.net>'))
      .toEqual({ name: 'Project 86, "Inc"', address: 'n@p86.net' });
  });
  test('a bare address and an angle-only address', () => {
    expect(sender.parseFromEnv('n@p86.net')).toEqual({ name: null, address: 'n@p86.net' });
    expect(sender.parseFromEnv('<n@p86.net>')).toEqual({ name: null, address: 'n@p86.net' });
  });
  test('garbage, CR/LF and non-strings parse to nothing', () => {
    expect(sender.parseFromEnv('not an address')).toEqual({ name: null, address: null });
    expect(sender.parseFromEnv('A <n@p86.net>\r\nBcc: x@y.com')).toEqual({ name: null, address: null });
    expect(sender.parseFromEnv(undefined)).toEqual({ name: null, address: null });
    expect(sender.parseFromEnv('')).toEqual({ name: null, address: null });
  });
});

describe('cleanOrgName', () => {
  test('an ordinary company name survives, comma and period included', () => {
    expect(sender.cleanOrgName('AG Exteriors, LLC')).toBe('AG Exteriors, LLC');
    expect(sender.cleanOrgName("O'Brien & Sons, Inc.")).toBe("O'Brien & Sons, Inc.");
  });

  test('CR/LF and other controls never survive (header injection)', () => {
    const out = sender.cleanOrgName('AG Exteriors\r\nBcc: victim@example.com');
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).not.toMatch(/@/);
    expect(sender.cleanOrgName('AG\tExteriors\u0000\u007f\u0085')).toBe('AG Exteriors');
  });

  test('quotes, backslashes, angle brackets and @ are removed', () => {
    const out = sender.cleanOrgName('"Evil" <ceo@bank.com> \\ x');
    expect(out).not.toMatch(/["\\<>@]/);
    expect(out).toBe('Evil ceo bank.com x');
  });

  test('bidi override and zero-width characters are stripped', () => {
    expect(sender.cleanOrgName('Acme\u202Efdp.exe')).toBe('Acmefdp.exe');
    expect(sender.cleanOrgName('Ac\u200Bme\u200D Roofing\uFEFF')).toBe('Acme Roofing');
    expect(sender.cleanOrgName('\u2066Acme\u2069')).toBe('Acme');
  });

  test('fullwidth lookalikes are folded (NFKC) before stripping', () => {
    expect(sender.cleanOrgName('ＡＧ＜Ｘ＞＠')).toBe('AG X');
  });

  test('a tenant calling itself Project 86 is refused, however spelled', () => {
    expect(sender.cleanOrgName('Project 86 Security')).toBeNull();
    expect(sender.cleanOrgName('project86')).toBeNull();
    expect(sender.cleanOrgName('PROJECT-86 billing')).toBeNull();
    expect(sender.cleanOrgName('Pro\u200Bject 86')).toBeNull();
    expect(sender.cleanOrgName('Ｐｒｏｊｅｃｔ ８６')).toBeNull();
  });

  test('empty, whitespace-only and letterless names are refused', () => {
    expect(sender.cleanOrgName('')).toBeNull();
    expect(sender.cleanOrgName('   ')).toBeNull();
    expect(sender.cleanOrgName(null)).toBeNull();
    expect(sender.cleanOrgName('12345')).toBeNull();
    expect(sender.cleanOrgName('"<>@\\')).toBeNull();
    expect(sender.cleanOrgName('\u202E\u200B')).toBeNull();
  });

  test('long unicode names are capped at 60 code points without splitting a pair', () => {
    const out = sender.cleanOrgName('Café Ñandú 🏠 '.repeat(20));
    expect(Array.from(out).length).toBeLessThanOrEqual(60);
    expect(out).toBe(out.trim());
    // No lone surrogate left behind by the cut.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
  });
});

// ── look-alikes and hidden fillers ──────────────────────────────────────
//
// WHAT WAS WRONG
// Both the send-time cleanOrgName and the save-time orgNameProblem (then a
// private copy in admin-organizations-routes.js) compared a lowercase
// letters-and-digits squash against "project86". NFKC does not turn Cyrillic
// into Latin, 0 into o, or Arabic-Indic digits into ASCII, and U+3164 / U+2800
// are a letter and a symbol rather than format characters, so every name in
// DISGUISED below saved AND went out as
//   "<name> via Project 86" <notifications@project86.net>
// reading as platform security or support mail.
//
// WHAT IS NOW HELD
// One exported orgNameProblem, run by both paths, judges a skeleton of the
// name. The DISGUISED names are refused at save and never brand a send; the
// ordinary names of real companies in other scripts still do.
//
// Characters are built from code points, never typed: a test full of
// homoglyphs cannot be read, and an editor can silently "fix" one.
const cp = (...codes) => String.fromCodePoint(...codes);

const DISGUISED = [
  ['a Cyrillic o', 'Pr' + cp(0x043E) + 'ject 86 Security'],
  ['a zero for the o', 'Pr0ject 86 Support'],
  ['a zero for the o, billing', 'Pr0ject 86 Billing'],
  ['Arabic-Indic 8 and 6', 'Project ' + cp(0x0668, 0x0666)],
  ['a small-capital R', 'P' + cp(0x0280) + 'oject 86'],
  ['Greek capitals P and O', cp(0x03A1) + 'r' + cp(0x039F) + 'ject 86'],
  ['a Cyrillic e and a 3 for another e', 'Proj' + cp(0x0435) + 'ct 86 and Proj3ct 86'],
  ['a 1 for the l in a respelled platform', 'PR0JECT-86 he1p desk'],
  ['Cherokee and Lisu capitals', cp(0x13E2) + 'roje' + cp(0xA4DA) + 't 86'],
  ['a Bengali four, which draws an 8', 'Project ' + cp(0x09EA) + '6'],
  ['a Cyrillic be, which draws a 6', 'Project 8' + cp(0x0431)],
  // NFKC turns the lunate sigma (a "c" to the eye) into a final sigma, which
  // is why the look-alike fold also runs BEFORE NFKC.
  ['a Greek lunate sigma for the c', 'Proje' + cp(0x03F2) + 't 86'],
  ['a capital lunate sigma for the C', 'PROJE' + cp(0x03F9) + 'T 86'],
  ['an accent on the o', 'Pro' + cp(0x0301) + 'ject 86'],
  ['a Hangul filler inside the name', 'P' + cp(0x3164) + 'roject 86'],
];

describe('orgNameProblem / cleanOrgName — look-alikes and hidden fillers', () => {
  const ENV = 'Project 86 <notifications@project86.net>';

  test.each(DISGUISED)('%s: refused at save, never brands a send', (_label, name) => {
    expect(sender.orgNameProblem(name)).toMatch(/^name /);
    expect(sender.cleanOrgName(name)).toBeNull();
    expect(sender.fromHeader(ENV, name)).toBe(ENV);
  });

  test('the disguised platform names all skeletonise to the platform key', () => {
    expect(sender.skeleton('Pr' + cp(0x043E) + 'ject 86 Security')).toBe('project86securlty');
    expect(sender.skeleton('Pr0ject 86')).toBe('project86');
    expect(sender.skeleton('Project ' + cp(0x0668, 0x0666))).toBe('project86');
    expect(sender.skeleton('P' + cp(0x3164) + 'roject 86')).toBe('project86');
    expect(sender.skeleton('P.r.o.j.e.c.t 8 6')).toBe('project86');
    expect(sender.skeleton(cp(0xFF30, 0xFF52) + 'oject ' + cp(0xFF18, 0xFF16))).toBe('project86');
    // Mathematical bold capital P, folded by NFKC before the table runs again.
    expect(sender.skeleton(cp(0x1D40F) + 'roject 86')).toBe('project86');
  });

  test('86 in the decimal digits of EVERY script is read as 86', () => {
    // Unicode assigns Nd digits in runs of ten, 0 through 9; a few runs sit
    // back to back. Walk every run and spell "Project 86" with its 8 and 6.
    const isNd = (c) => /\p{Nd}/u.test(String.fromCodePoint(c));
    const zeros = [];
    for (let c = 0; c < 0x110000; c++) {
      if (isNd(c) && !isNd(c - 1)) {
        let end = c;
        while (isNd(end)) end++;
        // The assumption the code rests on, checked against this runtime's
        // Unicode data rather than taken on trust.
        expect((end - c) % 10).toBe(0);
        for (let z = c; z < end; z += 10) zeros.push(z);
      }
    }
    expect(zeros.length).toBeGreaterThan(50);
    const passed = zeros.filter((z) => sender.orgNameProblem('Project ' + cp(z + 8, z + 6)) === null);
    expect(passed.map((z) => z.toString(16))).toEqual([]);
  });

  test('a name made only of a Hangul filler is refused and never brands', () => {
    const name = cp(0x3164);
    expect(sender.orgNameProblem(name)).toMatch(/invisible or blank filler/);
    expect(sender.cleanOrgName(name)).toBeNull();
    expect(sender.fromHeader(ENV, name)).toBe(ENV);
  });

  test('ACME padded with 55 blank Braille patterns: refused at save, the padding never reaches a header', () => {
    const name = 'ACME' + cp(0x2800).repeat(55);
    expect(sender.orgNameProblem(name)).toMatch(/invisible or blank filler/);
    expect(sender.cleanOrgName(name)).toBe('ACME');
    expect(sender.fromHeader(ENV, name)).toBe('"ACME via Project 86" <notifications@project86.net>');
  });

  test.each([
    ['U+115F HANGUL CHOSEONG FILLER', 0x115F],
    ['U+1160 HANGUL JUNGSEONG FILLER', 0x1160],
    ['U+3164 HANGUL FILLER', 0x3164],
    ['U+FFA0 HALFWIDTH HANGUL FILLER', 0xFFA0],
    ['U+2800 BRAILLE PATTERN BLANK', 0x2800],
    ['U+180E MONGOLIAN VOWEL SEPARATOR', 0x180E],
    ['U+17B4 KHMER VOWEL INHERENT AQ', 0x17B4],
    ['U+17B5 KHMER VOWEL INHERENT AA', 0x17B5],
    ['U+034F COMBINING GRAPHEME JOINER', 0x034F],
    ['U+1D159 MUSICAL SYMBOL NULL NOTEHEAD', 0x1D159],
    ['U+13441 EGYPTIAN HIEROGLYPH FULL BLANK', 0x13441],
  ])('%s: refused at save, alone, as padding, and inside the platform name', (_label, code) => {
    const ch = cp(code);
    expect(sender.orgNameProblem('AG' + ch + 'Exteriors')).toMatch(/^name /);
    expect(sender.orgNameProblem(ch.repeat(3))).toMatch(/^name /);
    expect(sender.cleanOrgName(ch.repeat(3))).toBeNull();
    expect(sender.cleanOrgName('Pro' + ch + 'ject 86')).toBeNull();
    const padded = sender.cleanOrgName('ACME' + ch.repeat(40));
    expect(padded).toBe('ACME');
  });

  test.each([
    'AG Exteriors, LLC',
    "O'Brien & Sons, Inc.",
    cp(0x0141) + cp(0x00F3) + 'd' + cp(0x017A) + ' Roofing',            // Lodz Roofing, Polish
    cp(0x039A, 0x03AC, 0x03C4, 0x03B9) + ' Construction',                // Greek "Kati"
    cp(0x682A, 0x5F0F, 0x4F1A, 0x793E) + ' ' + cp(0x5C71, 0x7530, 0x5EFA, 0x8A2D),   // Japanese KK
    'Jos' + cp(0x00E9) + "'s Painting",
    '86 Roofing Co',
    'Projects & Builders 86',
    // An emoji with its variation selector, standing apart from the letters
    // (attached to a word it is refused: see the third-round tests below).
    'Joe ' + cp(0x2615, 0xFE0F) + ' Coffee Roofing',
  ])('an ordinary company name still saves and brands: %s', (name) => {
    expect(sender.orgNameProblem(name)).toBeNull();
    expect(sender.cleanOrgName(name)).toBe(name);
    expect(sender.fromHeader(ENV, name)).toBe('"' + name + ' via Project 86" <notifications@project86.net>');
  });

  test('a name with no letter at all is refused at save as it is at send', () => {
    expect(sender.orgNameProblem('12345')).toMatch(/at least one letter/);
    expect(sender.cleanOrgName('12345')).toBeNull();
  });

  test('the save-time messages all start "name " (the invite route rewrites that to "org_name ")', () => {
    [
      'AG\tExteriors',
      'AG' + cp(0x202E) + 'Exteriors',
      'AG' + cp(0x3164) + 'Exteriors',
      '12345',
      'Pr0ject 86',
      'AG Ext' + cp(0x0435) + 'riors',
      'AG Ext' + cp(0x20AC) + 'riors',
    ].forEach((name) => expect(sender.orgNameProblem(name)).toMatch(/^name /));
  });
});

// ── the third round: one alphabet per word, nothing odd inside a word ────
//
// WHAT WAS WRONG
// The skeleton compared names against a hand-built look-alike table, and a
// review still beat it one character at a time. Every name in STILL_BRANDED
// saved and went out as "<name> via Project 86":
//   - a letter from another alphabet the table did not list (Myanmar, Tifinagh,
//     Malayalam, Oriya, Coptic, Deseret, Carian, ...) inside a Latin word;
//   - a symbol standing in for a letter (a white circle, a euro sign, a down
//     tack): the skeleton squashed it out, taking the letter's place with it;
//   - a spacing mark (a Telugu anusvara for the o) or a modifier letter (a
//     modifier apostrophe, a tatweel), stripped or kept in a way that broke
//     the match;
//   - Latin letters the table did not list (r with fishhook, barred o).
//
// WHAT IS NOW HELD
// Three layers, each able to refuse on its own, and the message names the
// FIRST that did (layers 1 and 2 run before layer 3):
//   alphabets     every character of a word that belongs to a script shares
//                 one (Japanese and Korean count their Han with their kana /
//                 Hangul);
//   inside a word no symbol but "+", no enclosing mark, no modifier letter or
//                 spacing mark of no particular script, no Latin modifier
//                 letter, no mark with no letter to sit on;
//   platform name the skeleton, its table extended, plus one run of
//                 punctuation or symbols allowed to stand for one letter.
// The layer column below is what pins each layer: drop the alphabet rule and
// the "alphabets" rows fall through to the table and change their message;
// drop the inside-a-word rule and the "inside a word" rows do the same.
const LAYER = {
  alphabets: /^name mixes lookalike letters from different alphabets$/,
  word: /^name cannot have symbols or stray marks inside a word/,
  platform: /^name cannot include "Project 86"/,
};

const STILL_BRANDED = [
  // [label, name, the layer that must refuse it]
  ['a euro sign for the e', 'Proj' + cp(0x20AC) + 'ct 86 Security', 'word'],
  ['a cent sign for the c', 'Proje' + cp(0x00A2) + 't 86 Security', 'word'],
  ['a white circle for the o', 'Pr' + cp(0x25CB) + 'ject 86 Security', 'word'],
  ['a white bullet for the o', 'Pr' + cp(0x25E6) + 'ject 86 Security', 'word'],
  ['a ring operator for the o', 'Pr' + cp(0x2218) + 'ject 86 Security', 'word'],
  ['an APL rho for the P', cp(0x2374) + 'roject 86 Security', 'word'],
  ['a down tack for the T', 'PROJEC' + cp(0x22A4) + ' 86', 'word'],
  ['a modifier-letter apostrophe inside the word', 'Pro' + cp(0x02BC) + 'ject 86', 'word'],
  ['a modifier vertical line before the 86', 'Project ' + cp(0x02C8) + '86', 'word'],
  ['an Oriya visarga (no letter to sit on) for the 8', 'Project ' + cp(0x0B03) + '6', 'word'],
  ['a negative squared P emoji', cp(0x1F17F, 0xFE0F) + 'roject 86', 'word'],
  ['a Telugu anusvara for the o', 'Pr' + cp(0x0C02) + 'ject 86 Security', 'alphabets'],
  ['a Sinhala anusvara for the o', 'Pr' + cp(0x0D82) + 'ject 86', 'alphabets'],
  ['an Arabic tatweel between the words', 'Project' + cp(0x0640) + '86', 'alphabets'],
  ['a Coptic capital Tau', 'PROJEC' + cp(0x2CA6) + ' 86', 'alphabets'],
  ['a Cyrillic er with tick', cp(0x048F) + 'roject 86', 'alphabets'],
  ['a Myanmar wa for the o', 'Pr' + cp(0x101D) + 'ject 86', 'alphabets'],
  ['a Tifinagh yar for the o', 'Pr' + cp(0x2D54) + 'ject 86', 'alphabets'],
  ['a Malayalam tta for the o', 'Pr' + cp(0x0D20) + 'ject 86', 'alphabets'],
  ['an Oriya tta for the o', 'Pr' + cp(0x0B20) + 'ject 86', 'alphabets'],
  ['a Georgian U+10FF for the o', 'Pr' + cp(0x10FF) + 'ject 86', 'alphabets'],
  ['a Hebrew samekh for the o', 'Pr' + cp(0x05E1) + 'ject 86', 'alphabets'],
  ['an Arabic heh for the o', 'Pr' + cp(0x0647) + 'ject 86', 'alphabets'],
  ['an ideographic number zero for the o', 'Pr' + cp(0x3007) + 'ject 86', 'alphabets'],
  ['an Armenian yi for the j', 'Pro' + cp(0x0575) + 'ect 86', 'alphabets'],
  ['a Cherokee small HU for the r', 'P' + cp(0xAB81) + 'oject 86', 'alphabets'],
  ['a Tifinagh yaddi for the E', 'PROJ' + cp(0x2D39) + 'CT 86', 'alphabets'],
  ['a Tai Le letter for the e', 'Proj' + cp(0x1971) + 'ct 86', 'alphabets'],
  ['a Deseret small chee for the C', 'PROJE' + cp(0x1043D) + 'T 86', 'alphabets'],
  ['a Deseret capital chee for the C', 'PROJE' + cp(0x10415) + 'T 86', 'alphabets'],
  ['a Carian letter for the C', 'PROJE' + cp(0x102A2) + 'T 86', 'alphabets'],
  ['a Greek small-capital rho for the P', cp(0x1D29) + 'roject 86', 'alphabets'],
  ['a Bopomofo letter for the T', 'Projec' + cp(0x3112) + ' 86', 'alphabets'],
  // Inside ONE alphabet the word rules have nothing to say: the table does.
  ['a Latin r with fishhook', 'P' + cp(0x027E) + 'oject 86', 'platform'],
  ['a Latin r without handle', 'P' + cp(0xAB47) + 'oject 86', 'platform'],
  ['a Latin sideways o', 'Pr' + cp(0x1D11) + 'ject 86', 'platform'],
  ['a Latin barred o', 'Pr' + cp(0x0275) + 'ject 86', 'platform'],
  ['a Latin o with long stroke', 'Pr' + cp(0xA74B) + 'ject 86', 'platform'],
  ['a Latin j with crossed tail', 'Pro' + cp(0x029D) + 'ect 86', 'platform'],
  ['a Latin j with stroke', 'Pro' + cp(0x0249) + 'ect 86', 'platform'],
  ['a Latin c with hook', 'Proje' + cp(0x0188) + 't 86', 'platform'],
  ['an Old Italic ef for the 8 (one letter, one alphabet)', 'Project ' + cp(0x1031A) + '6', 'platform'],
  ['a Warang Citi letter for the 6', 'Project 8' + cp(0x118D5), 'platform'],
  // Punctuation is fine inside a word, so a run of it standing for one letter
  // is caught by the gap check.
  ['a pair of parentheses for the o', 'Pr()ject 86 Security', 'platform'],
  ['a dagger for the t', 'Projec' + cp(0x2020) + ' 86', 'platform'],
];

describe('orgNameProblem — the third round of look-alikes', () => {
  const ENV = 'Project 86 <notifications@project86.net>';

  test.each(STILL_BRANDED)('%s: refused at save by the right layer, never brands a send', (_label, name, layer) => {
    expect(sender.orgNameProblem(name)).toMatch(LAYER[layer]);
    expect(sender.cleanOrgName(name)).toBeNull();
    expect(sender.fromHeader(ENV, name)).toBe(ENV);
  });

  test.each([
    'AG Exteriors, LLC',
    "O'Brien & Sons, Inc.",
    'O' + cp(0x2019) + 'Brien Roofing',                                             // the curly apostrophe
    cp(0x0141, 0x00F3) + 'd' + cp(0x017A) + ' Roofing',                               // Lodz, Polish
    cp(0x039A, 0x03AC, 0x03C4, 0x03B9) + ' Construction',                            // Greek
    cp(0x0421, 0x0442, 0x0440, 0x043E, 0x0439) + ' ' + cp(0x041F, 0x0440, 0x043E, 0x0435, 0x043A, 0x0442),   // Russian
    cp(0x682A, 0x5F0F, 0x4F1A, 0x793E) + ' ' + cp(0x5C71, 0x7530, 0x5EFA, 0x8A2D),   // Japanese KK
    cp(0x5C71, 0x7530, 0x5EFA, 0x8A2D) + ' ABC',                                     // Japanese, then Latin
    'Jos' + cp(0x00E9) + "'s Painting",
    '3M Roofing',
    '7-Eleven Supply',
    'A+ Gutters',
    '#1 Pavers',
    'Smith/Jones Build',
    'Tr1nity Roofing',
    'Nguy' + cp(0x1EC5) + 'n Construction',                                           // Vietnamese
    cp(0x00D8) + 'rsted Build',
    'Joe ' + cp(0x2615, 0xFE0F) + ' Coffee Roofing',                                  // a standalone emoji
    'Project 68 LLC',
    'Protect 86 Roofing',
    'Prospect 86',
    'Projects 86th St',
    // Modifier letters and spacing marks that belong to a script other than
    // Latin are that script's letters: real words need them.
    cp(0x4F50, 0x3005, 0x6728, 0x5EFA, 0x8A2D),                                       // Japanese iteration mark
    cp(0x30B9, 0x30FC, 0x30D1, 0x30FC, 0x30DB, 0x30FC, 0x30E0),                       // Japanese long-vowel mark
    cp(0x0928, 0x093F, 0x0930, 0x094D, 0x092E, 0x093E, 0x0923, 0x093E) + ' ' + cp(0x0915, 0x0902, 0x092A, 0x0928, 0x0940),   // Hindi vowel signs
    cp(0x0B95, 0x0B9F, 0x0BCD, 0x0B9F, 0x0BC1, 0x0BAE, 0x0BBE, 0x0BA9, 0x0BAE, 0x0BCD),   // Tamil vowel signs
    cp(0x0E01, 0x0E23, 0x0E38, 0x0E07, 0x0E40, 0x0E17, 0x0E1E, 0x0E2F, 0x0E46),       // Thai, with its repetition mark
    cp(0x5927, 0x97D3) + cp(0xAC74, 0xC124),                                          // Korean: Han and Hangul in one word
    cp(0x05D1, 0x05E2, 0x05F4, 0x05DE),                                               // Hebrew gershayim ("Ltd.")
    cp(0x0645, 0x0642, 0x0627, 0x0648, 0x0644, 0x0627, 0x062A),                       // Arabic
  ])('a real company name passes all three layers: %s', (name) => {
    expect(sender.orgNameProblem(name)).toBeNull();
    expect(sender.cleanOrgName(name)).toBe(name);
    expect(sender.fromHeader(ENV, name)).toBe('"' + name + ' via Project 86" <notifications@project86.net>');
  });

  test('the alphabet rule refuses on its own, on a name that spells nothing', () => {
    [
      'AG Ext' + cp(0x0435) + 'riors',                     // a Cyrillic e
      'Smith Roo' + cp(0x101D) + 'fing',                    // a Myanmar wa
      'Acme ' + cp(0x03A1) + 'ainting',                     // a Greek capital rho
      'Lodge' + cp(0x2CA6) + ' Builders',                   // a Coptic Tau
    ].forEach((name) => {
      expect(sender.orgNameProblem(name)).toMatch(LAYER.alphabets);
      expect(sender.cleanOrgName(name)).toBeNull();
    });
  });

  test('the alphabet rule is per word: Latin with Japanese or Korean needs a space between them', () => {
    expect(sender.orgNameProblem('ABC' + cp(0x5EFA, 0x8A2D))).toMatch(LAYER.alphabets);
    expect(sender.orgNameProblem('ABC ' + cp(0x5EFA, 0x8A2D))).toBeNull();
    expect(sender.orgNameProblem('LG' + cp(0xC804, 0xC790))).toMatch(LAYER.alphabets);
    expect(sender.orgNameProblem('LG ' + cp(0xC804, 0xC790))).toBeNull();
    // Hiragana and Hangul are no group together.
    expect(sender.orgNameProblem(cp(0x3072, 0xAC74))).toMatch(LAYER.alphabets);
  });

  test('the inside-a-word rule refuses on its own, on a name that spells nothing', () => {
    [
      'AG Ext' + cp(0x20AC) + 'riors',                     // a euro sign
      'Acme' + cp(0x25CB) + ' Roofing',                     // a white circle at the word's edge
      'Joe' + cp(0x2615, 0xFE0F) + ' Coffee Roofing',      // an emoji attached to a word
      'Hawai' + cp(0x02BB) + 'i Roofing',                   // a modifier letter of no script (the okina)
      'Acme ' + cp(0x0B03) + 'Roofing',                     // a spacing mark with no letter to sit on
      'Acme' + cp(0x20DD) + ' Roofing',                     // an enclosing circle
      'AG<X> Roofing',                                      // "<" is a symbol too (send time blanks it)
    ].forEach((name) => {
      expect(sender.orgNameProblem(name)).toMatch(LAYER.word);
    });
  });

  test('ordinary punctuation and a lone symbol between words are not inside a word', () => {
    [
      'AT&T Roofing', 'Smith, Jones & Co.', 'Roofing (USA)', 'C++ Builders',
      'Acme | Roofing', 'Acme ' + cp(0x2014) + ' Roofing', 'Acme Roofing: Commercial',
    ].forEach((name) => expect(sender.orgNameProblem(name)).toBeNull());
  });

  test('the skeleton folds symbols and spacing marks to their letter and squashes modifier letters', () => {
    expect(sender.skeleton('Pr' + cp(0x25CB) + 'ject 86')).toBe('project86');
    expect(sender.skeleton('Proj' + cp(0x20AC) + 'ct 86')).toBe('project86');
    expect(sender.skeleton('Pr' + cp(0x0C02) + 'ject 86')).toBe('project86');
    expect(sender.skeleton('PROJEC' + cp(0x2CA6) + ' 86')).toBe('project86');
    expect(sender.skeleton('Pro' + cp(0x02BC) + 'ject 86')).toBe('project86');
    expect(sender.skeleton('Project ' + cp(0x1031A) + cp(0x118D5))).toBe('project86');
  });

  test('the gap check takes ONE run for ONE letter, and never refuses an ordinary neighbour', () => {
    expect(sender.orgNameProblem('Pro(j)ect 86')).toMatch(LAYER.platform);     // squashed straight through
    expect(sender.orgNameProblem('P-o-e-t 86')).toBeNull();                     // three gaps are not a spelling
    expect(sender.orgNameProblem('Projects & Builders 86')).toBeNull();
    expect(sender.orgNameProblem('Pro-Jet 86 Roofing')).toBeNull();
  });

  test('every letter, mark and number of this runtime is neutral or in a compiled script', () => {
    // The list is spelled by hand; a script it misses would turn every letter
    // of that script into one "Unknown" alphabet. Check it against the
    // runtime's own Unicode data rather than take it on trust.
    const names = sender._SCRIPT_NAMES;
    ['Latin', 'Greek', 'Cyrillic', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Arabic', 'Devanagari']
      .forEach((n) => expect(names).toContain(n));
    const union = new RegExp('[' + names.concat(['Common', 'Inherited'])
      .map((n) => '\\p{Script_Extensions=' + n + '}').join('') + ']', 'u');
    const missed = [];
    for (let c = 0; c < 0x110000; c++) {
      if (c >= 0xD800 && c <= 0xDFFF) continue;
      const ch = String.fromCodePoint(c);
      if (/[\p{L}\p{M}\p{N}]/u.test(ch) && !union.test(ch)) missed.push(c.toString(16));
    }
    expect(missed).toEqual([]);
  });

  test('long names of never-seen characters are judged quickly, with no cache to lean on', () => {
    const started = Date.now();
    for (let i = 0; i < 50; i++) {
      // 200 different CJK Extension B ideographs a name, 10,000 in all, so the
      // cache never helps within the run.
      const name = Array.from({ length: 200 }, (_x, j) => cp(0x20000 + i * 200 + j)).join('');
      expect(sender.orgNameProblem(name)).toBeNull();
    }
    expect(Date.now() - started).toBeLessThan(10000);
  });
});

describe('fromHeader', () => {
  test('a clean org name brands the display name and keeps the EMAIL_FROM address', () => {
    expect(sender.fromHeader(ENV_FROM, 'AG Exteriors'))
      .toBe('"AG Exteriors via Project 86" <notifications@project86.net>');
    expect(sender.fromHeader('notifications@project86.net', 'AG Exteriors, LLC'))
      .toBe('"AG Exteriors, LLC via Project 86" <notifications@project86.net>');
  });

  test('an injection attempt yields one header line with one address', () => {
    const h = sender.fromHeader(ENV_FROM, 'Acme"\r\nBcc: x@evil.com <attacker@evil.com>');
    expect(h).not.toMatch(/[\r\n]/);
    expect(h.match(/</g).length).toBe(1);
    expect(h.endsWith('<notifications@project86.net>')).toBe(true);
    expect(h.match(/@/g).length).toBe(1);
    // Exactly the two quotes that delimit the display name.
    expect(h.match(/"/g).length).toBe(2);
  });

  test('a refused name falls back to EMAIL_FROM verbatim', () => {
    expect(sender.fromHeader(ENV_FROM, 'Project 86 Security')).toBe(ENV_FROM);
    expect(sender.fromHeader(ENV_FROM, '')).toBe(ENV_FROM);
    expect(sender.fromHeader(ENV_FROM, null)).toBe(ENV_FROM);
  });

  test('an unparseable EMAIL_FROM is never rewritten', () => {
    expect(sender.fromHeader('weird value', 'AG Exteriors')).toBe('weird value');
  });
});

describe('cleanReplyTo', () => {
  test('a plain address passes, trimmed', () => {
    expect(sender.cleanReplyTo(' pm@agx.com ', ['sub@example.com'])).toBe('pm@agx.com');
  });
  test('CR/LF, display names, lists and specials are refused', () => {
    expect(sender.cleanReplyTo('pm@agx.com\r\nBcc: x@y.com', [])).toBeNull();
    expect(sender.cleanReplyTo('pm@agx.com\n', [])).toBeNull();
    expect(sender.cleanReplyTo('PM <pm@agx.com>', [])).toBeNull();
    expect(sender.cleanReplyTo('a@agx.com, b@agx.com', [])).toBeNull();
    expect(sender.cleanReplyTo('a@agx.com;b@agx.com', [])).toBeNull();
    expect(sender.cleanReplyTo('no-at-sign', [])).toBeNull();
    expect(sender.cleanReplyTo('a@localhost', [])).toBeNull();
    expect(sender.cleanReplyTo('', [])).toBeNull();
    expect(sender.cleanReplyTo(false, [])).toBeNull();
    expect(sender.cleanReplyTo('a'.repeat(250) + '@x.com', [])).toBeNull();
  });
  test('an address equal to any recipient is dropped, case-insensitively', () => {
    expect(sender.cleanReplyTo('PM@AGX.com', ['other@x.com', 'pm@agx.com'])).toBeNull();
    expect(sender.cleanReplyTo('pm@agx.com', 'PM@agx.com')).toBeNull();
    expect(sender.cleanReplyTo('pm@agx.com', ['Pat <PM@agx.com>'])).toBeNull();
  });
});

// A users/organizations table with the predicates actually evaluated, so a
// lookup that dropped its org predicate would return the wrong row here.
function fakeDb(state) {
  const log = [];
  return {
    log,
    query: async (sql, params) => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      log.push({ sql: text, params });
      if (state.throws) throw new Error('db down');
      if (/^SELECT name FROM organizations WHERE id = \$1$/.test(text)) {
        const o = state.orgs.find((x) => String(x.id) === String(params[0]));
        return { rows: o ? [{ name: o.name }] : [] };
      }
      if (/^SELECT email FROM users WHERE id = \$1 AND organization_id = \$2 AND active = TRUE$/.test(text)) {
        const u = state.users.find((x) => String(x.id) === String(params[0]) &&
          String(x.organization_id) === String(params[1]) && x.active);
        return { rows: u ? [{ email: u.email }] : [] };
      }
      if (/FROM users WHERE organization_id = \$1 AND active = TRUE AND role IN \('admin', 'system_admin'\)/.test(text)) {
        const rows = state.users
          .filter((x) => String(x.organization_id) === String(params[0]) && x.active &&
            (x.role === 'admin' || x.role === 'system_admin') && x.email)
          .sort((a, b) => a.created_at - b.created_at || a.id - b.id);
        return { rows: rows.slice(0, 1).map((x) => ({ email: x.email })) };
      }
      throw new Error('unexpected SQL: ' + text);
    }
  };
}

describe('orgNameFor', () => {
  beforeEach(() => sender._clearOrgNameCache());

  test('reads the name by primary key and caches it', async () => {
    const db = fakeDb({ orgs: [{ id: 7, name: 'AG Exteriors' }], users: [] });
    expect(await sender.orgNameFor(db, 7)).toBe('AG Exteriors');
    expect(await sender.orgNameFor(db, 7)).toBe('AG Exteriors');
    expect(db.log.length).toBe(1);
    expect(db.log[0].params).toEqual([7]);
  });

  test('a miss, a null id and a throwing db all resolve to null', async () => {
    const db = fakeDb({ orgs: [], users: [] });
    expect(await sender.orgNameFor(db, 99)).toBeNull();
    expect(await sender.orgNameFor(db, null)).toBeNull();
    expect(await sender.orgNameFor(fakeDb({ throws: true, orgs: [], users: [] }), 7)).toBeNull();
    expect(await sender.orgNameFor(null, 7)).toBeNull();
  });
});

describe('replyToForUser', () => {
  const state = {
    orgs: [],
    users: [
      { id: 1, organization_id: 7, active: true, email: 'pm@agx.com', role: 'pm' },
      { id: 2, organization_id: 8, active: true, email: 'staff@platform.com', role: 'system_admin' },
      { id: 3, organization_id: 7, active: false, email: 'gone@agx.com', role: 'pm' },
      { id: 4, organization_id: 7, active: true, email: 'bad\r\n@agx.com', role: 'pm' }
    ]
  };

  test('the in-org active user resolves to their fresh address', async () => {
    const db = fakeDb(state);
    expect(await sender.replyToForUser(db, 1, 7)).toBe('pm@agx.com');
    expect(db.log[0].params).toEqual([1, 7]);
  });

  test('a user from another org (platform staff acting as the tenant) resolves to null', async () => {
    expect(await sender.replyToForUser(fakeDb(state), 2, 7)).toBeNull();
  });

  test('deactivated, malformed, missing ids and db errors resolve to null', async () => {
    expect(await sender.replyToForUser(fakeDb(state), 3, 7)).toBeNull();
    expect(await sender.replyToForUser(fakeDb(state), 4, 7)).toBeNull();
    expect(await sender.replyToForUser(fakeDb(state), null, 7)).toBeNull();
    expect(await sender.replyToForUser(fakeDb(state), 1, null)).toBeNull();
    expect(await sender.replyToForUser(fakeDb({ throws: true }), 1, 7)).toBeNull();
  });
});

describe('replyToForOrgAdmin', () => {
  test('the earliest-created active admin of THAT org', async () => {
    const db = fakeDb({
      orgs: [],
      users: [
        { id: 10, organization_id: 8, active: true, email: 'other-org-admin@x.com', role: 'admin', created_at: 1 },
        { id: 11, organization_id: 7, active: false, email: 'old-owner@agx.com', role: 'admin', created_at: 2 },
        { id: 12, organization_id: 7, active: true, email: 'owner@agx.com', role: 'system_admin', created_at: 3 },
        { id: 13, organization_id: 7, active: true, email: 'office@agx.com', role: 'admin', created_at: 4 },
        { id: 14, organization_id: 7, active: true, email: 'pm@agx.com', role: 'pm', created_at: 0 }
      ]
    });
    expect(await sender.replyToForOrgAdmin(db, 7)).toBe('owner@agx.com');
    expect(db.log[0].params).toEqual([7]);
  });

  test('no admin, no org id, or a db error -> null', async () => {
    expect(await sender.replyToForOrgAdmin(fakeDb({ orgs: [], users: [] }), 7)).toBeNull();
    expect(await sender.replyToForOrgAdmin(fakeDb({ orgs: [], users: [] }), null)).toBeNull();
    expect(await sender.replyToForOrgAdmin(fakeDb({ throws: true }), 7)).toBeNull();
  });
});
