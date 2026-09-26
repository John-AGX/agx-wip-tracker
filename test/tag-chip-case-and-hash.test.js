// A TAG IS WRITTEN THE WAY IT WAS TYPED, AND A CHIP IS NOT A HASHTAG.
//
// John, 2026-09-25, looking at the upload preview on his phone: "the tags
// shouldnt be lowercase by default and the hash tag doesn't need to be there".
//
// Two different faults with the same symptom (#office):
//
//   * js/projects.js mountTagEditor lowercased on the way in. Nothing else
//     did: server/services/attachment-tags.js keeps the author's case and says
//     so in its header, and the photo viewer's own editor (js/attachments.js)
//     keeps it too. So a tag added from a project — which is every tag added
//     to a photo on a walkthrough — was the only one that came out shouting
//     in lower case, and "Punch List" could never be written.
//
//   * every chip drew a '#' in front of the word. A chip is already a chip.
//
// Dedup stays case-INSENSITIVE, or the same tag arrives twice in two
// capitalisations and the catalog fills up with Office / office / OFFICE.
'use strict';

const fs = require('fs');
const path = require('path');

const FILES = ['js/projects.js', 'js/attachments.js', 'js/admin.js'].map(function (rel) {
  return { rel: rel, src: fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n') };
});
const PROJECTS = FILES[0].src;

// The shipped functions, lifted and run.
function lift(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name + ' any more');
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf('{', at); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  // eslint-disable-next-line no-new-func
  return new Function(src.slice(at, end) + '; return ' + name + ';')();
}

const hasTag = lift(PROJECTS, 'hasTag');
const hueFor = lift(PROJECTS, 'hueFor');
const previewHeading = lift(PROJECTS, 'previewHeading');

describe('the same tag in different capitals is the same tag', () => {
  test('hasTag matches whatever the capitals', () => {
    expect(hasTag(['Office'], 'office')).toBe(true);
    expect(hasTag(['office'], 'OFFICE')).toBe(true);
    expect(hasTag(['Punch List'], 'punch list')).toBe(true);
    expect(hasTag(['Office'], 'Offices')).toBe(false);
    expect(hasTag([], 'Office')).toBe(false);
  });

  test('and wears the same colour, so Office and office are not two chips', () => {
    expect(hueFor('Office')).toBe(hueFor('office'));
    expect(hueFor('Punch List')).toBe(hueFor('PUNCH LIST'));
  });
});

describe('the editor keeps the case somebody typed', () => {
  // The guard that was there: a lowercase() in commit(). If it comes back,
  // every tag added from a project is flattened again.
  test('commit() does not lowercase what it stores', () => {
    const commit = PROJECTS.slice(PROJECTS.indexOf('function commit(value)'), PROJECTS.indexOf('function renderSuggest'));
    expect(commit).toMatch(/String\(value \|\| ''\)\.trim\(\)\.slice\(0, 32\)/);
    expect(commit).not.toMatch(/toLowerCase/);
    // …and it still refuses a duplicate, case-insensitively.
    expect(commit).toMatch(/hasTag\(current, clean\)/);
  });

  test('the typed word reaches the suggestions as typed', () => {
    const suggest = PROJECTS.slice(PROJECTS.indexOf('function renderSuggest'), PROJECTS.indexOf('function renderSuggest') + 2000);
    expect(suggest).toMatch(/var typed = String\(input\.value \|\| ''\)\.trim\(\)\.slice\(0, 32\);/);
    expect(suggest).not.toMatch(/typed = [^;]*toLowerCase/);
  });
});

describe('no chip draws a hash', () => {
  test('nowhere in the three files that render tags', () => {
    for (const f of FILES) {
      const hashed = f.src.match(/'#' \+ escapeHTML(Local)?\(/g) || [];
      expect([f.rel, hashed]).toEqual([f.rel, []]);
      const inline = f.src.match(/>#' \+ escapeHTML(Local)?\(/g) || [];
      expect([f.rel, inline]).toEqual([f.rel, []]);
    }
  });
});

describe('the upload preview heading', () => {
  test('a camera filename is not a name — the photo is right there', () => {
    expect(previewHeading({ name: '17904256268456008751715988656382.jpg' }, true)).toBe('Add photo');
    expect(previewHeading({ name: 'IMG_4821.jpg' }, true)).toBe('Add photo');
    expect(previewHeading({ name: 'PXL_20260925_122430.jpg' }, true)).toBe('Add photo');
    expect(previewHeading({ name: '' }, true)).toBe('Add photo');
  });

  test('a name somebody chose is kept', () => {
    expect(previewHeading({ name: 'Bldg 4 pump room.jpg' }, true)).toBe('Bldg 4 pump room.jpg');
  });

  test('a document keeps its filename either way — there is nothing to look at', () => {
    expect(previewHeading({ name: 'scope.pdf' }, false)).toBe('scope.pdf');
  });
});

describe('the actions row is as short as the moment allows', () => {
  // js/projects.js builds several modals; the end marker has to be the one
  // that follows THIS one, or the slice runs backwards and every assertion
  // below passes against an empty string.
  const start = PROJECTS.indexOf('modal.id = \'projUploadPreview\'');
  const modal = PROJECTS.slice(start, PROJECTS.indexOf('document.body.appendChild(modal)', start));

  test('the slice really is the upload preview', () => {
    expect(start).toBeGreaterThan(0);
    expect(modal).toMatch(/id="upPrevCaption"/);
  });

  test('Cancel is the × in the header, not a fourth button', () => {
    expect(modal).toMatch(/class="p86-modal-close" data-close/);
    expect(modal).not.toMatch(/data-close>Cancel</);
  });

  test('Save & finish and the skip-the-rest box are hidden until a walkthrough runs', () => {
    for (const id of ['upPrevDone', 'upPrevAgainWrap']) {
      const at = modal.indexOf('id="' + id + '"');
      expect([id, at >= 0]).toEqual([id, true]);
      expect([id, modal.slice(at, at + 100)]).toEqual([id, expect.stringContaining('style="display:none;"')]);
    }
    expect(PROJECTS).toMatch(/if \(againWrap && _walkthroughKeepOpen\) againWrap\.style\.display = '';/);
  });

  test('Save is always there', () => {
    expect(modal).toMatch(/class="primary" id="upPrevSave">Save</);
  });

  // "move the buttons under the photo" + "can you consolidate any of the
  // buttons aswell?" — John, 2026-09-26. Quick save was a third button that
  // did what Save does and set a preference; the preference moved into the
  // body as a checkbox, and Markup moved onto the photo.
  test('two buttons in the footer, never three', () => {
    const footer = modal.slice(modal.indexOf('modal-footer p86-upload-actions'));
    expect((footer.match(/<button /g) || []).length).toBe(2);
    expect(PROJECTS).not.toMatch(/upPrevQuick/);
  });

  test('Markup is a chip on the photo, not a row under it', () => {
    const shot = modal.slice(modal.indexOf('p86-upload-shot'), modal.indexOf('id="upPrevCaption"'));
    expect(shot).toMatch(/class="p86-upload-markup" id="upPrevAnnotate"/);
    expect(shot).toMatch(/id="upPrevAnnoCount"/);
    // …and a document has nothing to draw on, so it gets no chip — which
    // means the wiring has to tolerate the button being absent.
    expect(PROJECTS).toMatch(/var annoBtn = modal\.querySelector\('#upPrevAnnotate'\);\r?\n\s*if \(annoBtn\) annoBtn\.addEventListener/);
  });
});

// The footer moves BELOW the body on this screen only. Every other modal in
// the app leans on .modal-footer { order: -1 } to keep Save above a long
// form, so this has to be a scoped override, never a change to that rule.
describe('the actions sit under the photo, and only here', () => {
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8').replace(/\r\n/g, '\n');

  test('the app-wide rule still puts actions above the body', () => {
    const at = CSS.indexOf('.modal-footer {');
    expect(at).toBeGreaterThan(0);
    expect(CSS.slice(at, CSS.indexOf('}', at))).toMatch(/order:\s*-1;/);
  });

  test('the upload preview overrides it for itself', () => {
    const at = CSS.indexOf('.p86-upload-modal .modal-footer {');
    expect(at).toBeGreaterThan(0);
    const scoped = CSS.slice(at, CSS.indexOf('}', at));
    expect(scoped).toMatch(/order:\s*0;/);
    // Sticky, or the reason for the app-wide rule bites here too: a tall
    // photo would scroll Save off the bottom of the dialog.
    expect(scoped).toMatch(/position:\s*sticky;/);
    expect(scoped).toMatch(/bottom:\s*0;/);
    // …and opaque, or the photo shows through the buttons as it passes.
    expect(scoped).toMatch(/background:\s*var\(--surface\);/);
  });

  test('the markup chip is positioned on the photo', () => {
    const shot = CSS.slice(CSS.indexOf('.p86-upload-shot {'), CSS.indexOf('.p86-upload-again {'));
    expect(shot).toMatch(/\.p86-upload-shot \{[^}]*position:\s*relative/);
    expect(shot).toMatch(/\.p86-upload-markup, \.p86-upload-annocount \{[^}]*position:\s*absolute/);
  });
});
