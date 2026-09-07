// THE ONE PROPERTY WHOSE FAILURE HANDS A STRANGER SOMEBODY ELSE'S MAIL:
// a local part, once issued, is never released — not even by deleting the user.
//
// WHY THIS FILE IS SEPARATE FROM inbound-address-aliases.test.js
// That file runs against test/helpers/db-schema.js, whose sqliteSchema()
// deliberately derives COLUMNS ONLY and drops every table constraint except a
// primary key the caller names. That is the right trade for route tests — but
// it means the foreign-key ACTION is not present, so `ON DELETE SET NULL` is
// simulated there by performing its effect rather than executed. If somebody
// changed the production DDL to ON DELETE CASCADE, that file would stay green
// while the row vanished, the string was released, and the next person to ask
// for `john.agx` received John's mail.
//
// So this file takes the REAL CREATE TABLE TEXT out of server/db.js, translates
// only the Postgres spellings sqlite does not share, and runs it. The FK action
// under test is the one that ships. sqlite enforces `ON DELETE SET NULL` with
// PRAGMA foreign_keys = ON, so the delete is executed and the surviving row is
// the answer — not an assertion about a string in a file.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_JS = path.join(__dirname, '..', 'server', 'db.js');

// Pull the statement out by name, balancing parentheses rather than matching to
// the first ')' — the column list contains none, but a future one might, and a
// truncated CREATE TABLE would fail in a way that looks like a schema bug.
function createTableText(name) {
  const src = fs.readFileSync(DB_JS, 'utf8');
  const re = new RegExp('CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?' + name + '\\s*\\(', 'i');
  const m = re.exec(src);
  if (!m) throw new Error('server/db.js does not create ' + name);
  let depth = 1, i = m.index + m[0].length;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') depth--;
  }
  return src.slice(m.index, i) + ';';
}

// Only the spellings sqlite does not share. Nothing here touches REFERENCES or
// the ON DELETE action — those are the subject of the test and are executed
// verbatim.
function toSqlite(ddl) {
  return ddl
    .replace(/TIMESTAMPTZ/gi, 'TEXT')
    .replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP');
}

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, active INTEGER DEFAULT 1, organization_id INTEGER);');
  db.exec('CREATE TABLE organizations (id INTEGER PRIMARY KEY, slug TEXT);');
  db.exec(toSqlite(createTableText('user_email_aliases')));
  db.exec("INSERT INTO organizations (id, slug) VALUES (1, 'agx');");
  db.exec("INSERT INTO users (id, email, organization_id) VALUES (10, 'john@agxco.com', 1);");
  db.exec("INSERT INTO user_email_aliases (local_part, user_id, original_user_id, organization_id, source)" +
          " VALUES ('john.agx', 10, 10, 1, 'assigned'), ('john-46bbee', 10, 10, 1, 'minted');");
  return db;
}
const rows = (db, sql) => db.prepare(sql).all();

describe('the real DDL, executed', () => {
  it('is the shape that makes never-reissue true: local_part is the PRIMARY KEY', () => {
    const db = freshDb();
    // Global across every tenant — there is no organization in the key, so two
    // orgs cannot mint the same string even by accident.
    expect(() => db.exec("INSERT INTO user_email_aliases (local_part, user_id) VALUES ('john.agx', 999)"))
      .toThrow(/UNIQUE|PRIMARY KEY/i);
    expect(rows(db, "SELECT user_id FROM user_email_aliases WHERE local_part = 'john.agx'")[0].user_id).toBe(10);
  });

  it('deleting the user LEAVES THE ROW, with the owner nulled', () => {
    const db = freshDb();
    db.exec('DELETE FROM users WHERE id = 10;');
    const surviving = rows(db, "SELECT local_part, user_id, original_user_id FROM user_email_aliases ORDER BY local_part");
    // Both addresses are still on the table. Under ON DELETE CASCADE this
    // array is empty and both strings are free for the taking.
    expect(surviving.map((r) => r.local_part)).toEqual(['john-46bbee', 'john.agx']);
    expect(surviving.every((r) => r.user_id === null)).toBe(true);
    // original_user_id is untouched by the FK action, so the trail survives the
    // delete and it is still possible to say whose address this was.
    expect(surviving.every((r) => r.original_user_id === 10)).toBe(true);
  });

  it('and the burned string still cannot be handed to anybody else', () => {
    const db = freshDb();
    db.exec('DELETE FROM users WHERE id = 10;');
    db.exec("INSERT INTO users (id, email, organization_id) VALUES (11, 'stranger@agxco.com', 1);");
    expect(() => db.exec("INSERT INTO user_email_aliases (local_part, user_id) VALUES ('john.agx', 11)"))
      .toThrow(/UNIQUE|PRIMARY KEY/i);
  });

  it('the delete does not cascade into anything else either', () => {
    // RESTRICT would have made DELETE /api/auth/users/:id start failing on a
    // live pilot — a behaviour change nobody asked for. The delete must succeed.
    const db = freshDb();
    expect(() => db.exec('DELETE FROM users WHERE id = 10;')).not.toThrow();
    expect(rows(db, 'SELECT id FROM users')).toEqual([]);
  });

  it('names the FK action explicitly, so a silent change to CASCADE is not possible', () => {
    // The behaviour above is the real guard. This reads the text as well,
    // because a reviewer looking at the diff of a future DDL change should see
    // a test that names the exact words, and because the tests above would also
    // pass if the REFERENCES clause were removed entirely (no FK = no cascade).
    // Belt and braces, and the braces are the four tests above.
    const ddl = createTableText('user_email_aliases');
    expect(ddl).toMatch(/user_id\s+INTEGER\s+REFERENCES\s+users\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i);
    expect(ddl).not.toMatch(/ON\s+DELETE\s+CASCADE/i);
    expect(ddl).toMatch(/local_part\s+TEXT\s+PRIMARY\s+KEY/i);
  });
});
