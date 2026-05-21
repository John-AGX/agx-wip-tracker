// csv-payload-converter.js — Project 86 Payload DSL (C14).
//
// Converts an uploaded CSV file into a payloads row with N create-ops
// targets, one per row. The user reviews the resulting file artifact
// in the sidebar and drags it into the dropbox to apply.
//
// Supported entity_types in v1: 'lead', 'client'. Adding more is a
// matter of adding a mapping in FIELD_MAPPERS below — the dispatcher
// already supports `op:'create'` on every entity_type that ships in
// C3 + C5.
//
// CSV parsing is minimal — handles quoted strings (including escaped
// internal quotes via "" or \"), comma + newline separation, BOM at
// the start of the file. No fancy features (we don't need delimiter
// detection, multi-line fields beyond quoted, or column-shape coercion
// beyond what FIELD_MAPPERS does). If users hit edge cases we'll add
// papaparse later.

const dispatcher = require('./payload-dispatcher');

// ──────────────────────────────────────────────────────────────────
// FIELD_MAPPERS — per-entity_type recipe for turning a CSV row into
// an ops.fields object. Keys are normalized to lowercase + non-alnum
// stripped before lookup so "Title", "TITLE ", and "title" all hit.
//
// Each mapper returns {fields, errors} so converting one bad row
// doesn't kill the whole batch.
// ──────────────────────────────────────────────────────────────────

function normalizeKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// LEAD column aliases — accept the columns Buildertrend, common
// spreadsheet exports, and AGX's own naming might produce.
const LEAD_COLUMN_ALIASES = {
  title:                 ['title', 'name', 'leadtitle', 'projectname'],
  client_id:             ['clientid', 'client_id'],
  street_address:        ['streetaddress', 'address', 'street', 'address1'],
  city:                  ['city'],
  state:                 ['state', 'region'],
  zip:                   ['zip', 'zipcode', 'postal', 'postalcode'],
  status:                ['status', 'leadstatus'],
  confidence:            ['confidence', 'confidencepct'],
  projected_sale_date:   ['projectedsaledate', 'closedate', 'expectedclose'],
  estimated_revenue_low: ['estimatedrevenuelow', 'revenuelow', 'lowestimate'],
  estimated_revenue_high:['estimatedrevenuehigh', 'revenuehigh', 'highestimate', 'estimatedrevenue'],
  source:                ['source', 'leadsource', 'dealsource'],
  project_type:          ['projecttype', 'type', 'work'],
  salesperson_id:        ['salespersonid', 'salesperson'],
  property_name:         ['propertyname', 'community', 'communityname'],
  market:                ['market'],
  notes:                 ['notes', 'description'],
};

const CLIENT_COLUMN_ALIASES = {
  name:                  ['name', 'clientname', 'fullname'],
  client_type:           ['clienttype', 'type'],
  first_name:            ['firstname', 'first'],
  last_name:             ['lastname', 'last'],
  email:                 ['email', 'emailaddress'],
  phone:                 ['phone', 'phonenumber'],
  cell:                  ['cell', 'mobile', 'cellphone'],
  address:               ['address', 'address1', 'streetaddress'],
  city:                  ['city'],
  state:                 ['state'],
  zip:                   ['zip', 'zipcode', 'postal'],
  company_name:          ['companyname', 'company', 'parentcompany'],
  community_name:        ['communityname', 'community', 'propertyname'],
  market:                ['market'],
  property_address:      ['propertyaddress', 'siteaddress'],
  community_manager:     ['communitymanager', 'cam', 'manager'],
  cm_email:              ['cmemail', 'manageremail'],
  cm_phone:              ['cmphone', 'managerphone'],
  short_name:            ['shortname', 'abbreviation', 'qbname'],
  notes:                 ['notes'],
};

const FIELD_MAPPERS = {
  lead:   { aliases: LEAD_COLUMN_ALIASES,   requiredFields: ['title'] },
  client: { aliases: CLIENT_COLUMN_ALIASES, requiredFields: ['name']  },
};

function buildHeaderMap(headers, aliases) {
  // Map each header → canonical field name (or null if not recognized).
  const out = new Array(headers.length).fill(null);
  for (let i = 0; i < headers.length; i++) {
    const n = normalizeKey(headers[i]);
    for (const canonical of Object.keys(aliases)) {
      if (aliases[canonical].indexOf(n) !== -1) {
        out[i] = canonical;
        break;
      }
    }
  }
  return out;
}

function rowToFields(row, headerMap) {
  const fields = {};
  for (let i = 0; i < headerMap.length; i++) {
    const canonical = headerMap[i];
    if (!canonical) continue;
    const v = row[i];
    if (v == null || String(v).trim() === '') continue;
    fields[canonical] = String(v).trim();
  }
  return fields;
}

// ──────────────────────────────────────────────────────────────────
// parseCsv — minimal RFC-4180-ish parser. Returns [[cell, cell, ...], ...].
// Handles: quoted strings, "" escapes inside quotes, CRLF and LF
// line endings, BOM at start. Does NOT handle: stream parsing, custom
// delimiters, header detection (caller decides).
// ──────────────────────────────────────────────────────────────────

function parseCsv(text) {
  if (!text) return [];
  // Strip BOM if present.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(cur);
        cur = '';
      } else if (ch === '\n' || ch === '\r') {
        row.push(cur);
        cur = '';
        // Skip \r\n pair
        if (ch === '\r' && text[i + 1] === '\n') i++;
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else {
        cur += ch;
      }
    }
  }
  // Final row
  if (cur !== '' || row.length) {
    row.push(cur);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

// ──────────────────────────────────────────────────────────────────
// convertCsvToPayload — public entry point.
//
// Args:
//   bufferOrText: Buffer | string — CSV content
//   entityType:   'lead' | 'client'
//   opts:         { organizationId, userId, sessionId? }
//
// Returns: { payload_id, filename, target_count, csv_errors, file_content }
// Throws on hard validation (unknown entity_type, empty file, missing
// required column for ALL rows).
// ──────────────────────────────────────────────────────────────────

async function convertCsvToPayload(bufferOrText, entityType, opts = {}) {
  if (!FIELD_MAPPERS[entityType]) {
    throw new Error(`CSV import not supported for entity_type='${entityType}'. ` +
      `Supported: ${Object.keys(FIELD_MAPPERS).join(', ')}.`);
  }
  const mapper = FIELD_MAPPERS[entityType];

  const text = Buffer.isBuffer(bufferOrText)
    ? bufferOrText.toString('utf8')
    : String(bufferOrText || '');
  const rows = parseCsv(text);
  if (rows.length < 2) {
    throw new Error('CSV must have a header row + at least one data row');
  }
  const headers = rows[0];
  const headerMap = buildHeaderMap(headers, mapper.aliases);
  // At least ONE canonical column must be recognized — otherwise the
  // file is garbage or for the wrong entity_type.
  if (!headerMap.some((c) => c !== null)) {
    throw new Error(
      `No recognized columns in CSV header. Expected at least one of: ` +
      Object.keys(mapper.aliases).join(', ')
    );
  }

  const targets = [];
  const csvErrors = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.length || row.every((c) => !c || !String(c).trim())) continue; // blank line
    const fields = rowToFields(row, headerMap);
    const missing = mapper.requiredFields.filter((rf) => !fields[rf]);
    if (missing.length) {
      csvErrors.push({
        row_number: i + 1,
        error: 'missing required field(s): ' + missing.join(', '),
        row_preview: row.slice(0, 4).join(' | ').slice(0, 200),
      });
      continue;
    }
    // Build a unique $ref placeholder so the dispatcher's ref-table
    // can register each new id (useful when a later CSV import wants
    // to reference rows from a prior one — for now each payload is
    // self-contained, but the scaffolding's there).
    targets.push({
      entity_type: entityType,
      entity_id: '$new_' + entityType + '_' + i,
      entity_display: fields[mapper.requiredFields[0]] || ('CSV row ' + (i + 1)),
      ops: {
        op: 'create',
        fields,
      },
    });
  }

  if (!targets.length) {
    throw new Error('No valid rows after CSV parse. ' + csvErrors.length + ' rows had errors.');
  }

  // Validate ops shape via the dispatcher BEFORE persisting so the
  // user doesn't get a payload they can never apply.
  for (const t of targets) {
    try {
      dispatcher.validateOps(entityType, t.ops);
    } catch (err) {
      throw new Error('Validation failed on built ops: ' + err.message);
    }
  }

  const payloadId = dispatcher.newPayloadId();
  const title = 'CSV import — ' + targets.length + ' ' + entityType + (targets.length === 1 ? '' : 's');
  const summary = targets.length + ' new ' + entityType + (targets.length === 1 ? '' : 's') +
    ' from CSV upload' +
    (csvErrors.length ? ' (' + csvErrors.length + ' rows skipped — see csv_errors)' : '');
  const rationale = 'Bulk CSV import (' + entityType + '). User-uploaded file produced ' +
    targets.length + ' rows; ' + csvErrors.length + ' rows had errors and were skipped.';
  const filename = dispatcher.generateFilename(targets, title);
  const fileContent = {
    version: 1,
    id: payloadId,
    filename,
    targets,
    title,
    summary,
    rationale,
    source: 'csv_import',
    csv_errors: csvErrors,
    emitted_at: new Date().toISOString(),
  };

  return {
    payload_id: payloadId,
    filename,
    target_count: targets.length,
    csv_errors: csvErrors,
    file_content: fileContent,
    targets,
    title,
    summary,
    rationale,
  };
}

module.exports = {
  convertCsvToPayload,
  // Lower-level exports for tests + future enhancements.
  internals: {
    parseCsv,
    buildHeaderMap,
    rowToFields,
    normalizeKey,
    FIELD_MAPPERS,
  },
};
