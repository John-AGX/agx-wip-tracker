// A PHOTO TAKEN ON A PROJECT ASKS WHAT IT IS (js/projects.js).
//
// John, 2026-09-25, after taking a photo on a project: "when I clicked okay it
// didn't give me the option at all to do the dictate or annotate or tag. I
// want that bubble block to come up."
//
// It could not. Both capture buttons called uploadFiles with quickSave: true,
// which skips openUploadPreview — the block that holds the caption, the
// microphone, the tags and Annotate before saving. The comment above them said
// "caption/annotate happen in the viewer", but nothing on the Photos tab ever
// opened the viewer after an upload (that behaviour was added to the OTHER
// attachment grid, js/attachments.js, and this screen does not use it). So a
// photo taken on a walkthrough was saved silently, with nowhere to say what it
// was a picture of.
//
// What is pinned here:
//   * the rule itself — one photo gets the block, a bulk pick does not, and a
//     walkthrough that has said "skip" is not asked again;
//   * that all three ways in (camera, library, drag-drop) decide through that
//     one rule, so nobody re-hardcodes quickSave: true on one of them;
//   * that the block still contains the four things it is wanted for.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'projects.js'), 'utf8').replace(/\r\n/g, '\n');

// The shipped function, lifted and run — not a copy of its logic.
function lift(name) {
  const at = SRC.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('no function ' + name + ' in js/projects.js any more');
  let depth = 0;
  let end = -1;
  for (let i = SRC.indexOf('{', at); i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error('unbalanced ' + name);
  // eslint-disable-next-line no-new-func
  return new Function(SRC.slice(at, end) + '; return ' + name + ';')();
}

const wantsPreview = lift('wantsPreview');

describe('which photos get the caption / dictate / tag / annotate block', () => {
  test('one photo does — the shot somebody just took', () => {
    expect(wantsPreview(1, false)).toBe(true);
  });

  test('a bulk pick does not: twenty photos is a transfer, not twenty decisions', () => {
    expect(wantsPreview(2, false)).toBe(false);
    expect(wantsPreview(20, false)).toBe(false);
  });

  test('and a walkthrough that already said skip is not asked again', () => {
    expect(wantsPreview(1, true)).toBe(false);
  });

  test('nothing at all is not a photo', () => {
    expect(wantsPreview(0, false)).toBe(false);
    expect(wantsPreview(undefined, false)).toBe(false);
  });
});

describe('every way a photo arrives decides through that one rule', () => {
  // The three call sites. A quickSave that is not computed from wantsPreview
  // is the defect this file exists to stop coming back.
  test('camera, library and drag-drop all call wantsPreview', () => {
    // The definition is not a call site: only the three ways in count.
    const calls = SRC.match(/(?<!function )uploadFiles\(\s*[A-Za-z_$][^;]*?\{[\s\S]*?\}\s*\)/g) || [];
    expect(calls.length).toBe(3);
    for (const c of calls) {
      expect([c.slice(0, 60), /wantsPreview\(/.test(c)]).toEqual([c.slice(0, 60), true]);
      expect([c.slice(0, 60), /quickSave:\s*true/.test(c)]).toEqual([c.slice(0, 60), false]);
    }
  });

  test('the camera keeps the loop open, and only the camera does', () => {
    const camera = SRC.slice(SRC.indexOf("cameraInput.addEventListener"), SRC.indexOf("fileInput.addEventListener"));
    expect(camera).toMatch(/keepOpen:\s*true/);
    expect(camera).toMatch(/_walkthroughQuickSave/);
  });

  test('a skip lasts the walkthrough and no longer', () => {
    // Set when Quick save is pressed inside the loop …
    expect(SRC).toMatch(/if \(_walkthroughKeepOpen\) _walkthroughQuickSave = true;/);
    // … cleared by Save & finish, and by any batch that is not the loop.
    expect(SRC).toMatch(/_walkthroughKeepOpen = false;\n\s*_walkthroughQuickSave = false;/);
    expect(SRC).toMatch(/if \(!_walkthroughKeepOpen\) _walkthroughQuickSave = false;/);
  });
});

describe('the block holds what it is wanted for', () => {
  const modal = SRC.slice(SRC.indexOf('function openUploadPreview'), SRC.indexOf('function openUploadPreview') + 6000);

  test('a caption, a microphone, tags and Annotate before saving', () => {
    expect(modal).toMatch(/id="upPrevCaption"/);
    expect(modal).toMatch(/id="upPrevMic"/);
    expect(modal).toMatch(/id="upPrevTagsEditor"/);
    expect(modal).toMatch(/id="upPrevAnnotate"/);
  });

  test('and a way out of it that does not cost the photo', () => {
    expect(modal).toMatch(/id="upPrevQuick"/);
    expect(modal).toMatch(/id="upPrevSave"/);
  });
});
