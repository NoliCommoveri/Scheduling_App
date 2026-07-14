// import-core.js — the source-independent substance of Packet Import (Module 2):
// parse, version-gate, schema-validate, then the relational second pass that no
// JSON-Schema keyword can express (TDS §2; SRS Module 2 FR-2/FR-3/§5).
// Pure functions only — no File, no IndexedDB, no DOM — so the same code runs in
// the browser and under Node against the golden fixtures.

(function (g) {
  "use strict";

  var CANON_BLOCKS = ["morning", "afternoon", "evening", "night"];
  var SUPPORTED_SCHEMA_VERSION = 1;

  // ISO YYYY-MM-DD strings compare correctly with plain string comparison.
  function dateLE(a, b) { return a <= b; }

  // The eight relational constraints of TDS §2. Returns an array of messages.
  function secondPass(packet) {
    var errors = [];

    // 1. coversFrom <= coversTo
    if (!dateLE(packet.coversFrom, packet.coversTo)) {
      errors.push("The packet's date range is backwards (coversFrom is after coversTo).");
    }

    var seenDates = Object.create(null);
    var seenIds = Object.create(null); // Activity + Chore ids only

    (packet.days || []).forEach(function (day) {
      // 5. every day date inside the packet range
      if (!(dateLE(packet.coversFrom, day.date) && dateLE(day.date, packet.coversTo))) {
        errors.push("Day " + day.date + " falls outside the packet's date range.");
      }
      // 6. no duplicate day date
      if (seenDates[day.date]) {
        errors.push("The date " + day.date + " appears more than once in the packet.");
      }
      seenDates[day.date] = true;

      (day.activities || []).forEach(function (a) {
        // 7. no duplicate Activity/Chore id
        if (seenIds[a.id]) errors.push("The id '" + a.id + "' appears more than once.");
        seenIds[a.id] = true;

        var kind = a.payload && a.payload.kind;
        // 2. pageRangeEnd >= pageRangeStart
        if (kind === "pageRange" && a.payload.pageRangeEnd < a.payload.pageRangeStart) {
          errors.push("'" + a.id + "' has a page range that ends before it starts.");
        }
        // 8. sequenceNumber required for count-structured kinds (reference, none)
        if ((kind === "reference" || kind === "none") &&
            typeof a.sequenceNumber !== "number") {
          errors.push("'" + a.id + "' needs a sequence number (it is a count-structured item).");
        }
      });

      (day.chores || []).forEach(function (c) {
        if (seenIds[c.id]) errors.push("The id '" + c.id + "' appears more than once.");
        seenIds[c.id] = true;
        // 3. chore's own date must equal the enclosing day's date
        if (c.date !== day.date) {
          errors.push("Chore '" + c.id + "' has a date (" + c.date +
            ") that disagrees with its day (" + day.date + ").");
        }
      });

      (day.events || []).forEach(function (e) {
        // 4. event must overlap the packet range (overlap, not containment).
        //    A multi-day event legitimately repeats its EVT id across days, so
        //    event ids are intentionally excluded from the duplicate-id check.
        var overlaps = dateLE(e.startDate, packet.coversTo) && dateLE(packet.coversFrom, e.endDate);
        if (!overlaps) {
          errors.push("Event '" + e.id + "' lies entirely outside the packet's date range.");
        }
      });
    });

    return errors;
  }

  // Full pipeline. Returns:
  //   { ok:true,  packet }                        — safe to merge
  //   { ok:false, versionError:true, message }     — version gate (FR-2), distinct message
  //   { ok:false, parseError:true,   message }     — not valid JSON
  //   { ok:false, errors:[...] }                   — schema and/or relational failures
  function parseAndValidate(text, schema) {
    var packet;
    try {
      packet = JSON.parse(text);
    } catch (e) {
      return { ok: false, parseError: true, message: "That file isn't valid JSON, so it can't be a packet." };
    }

    // FR-2: version gate BEFORE any content parsing, with its own plain message.
    if (packet == null || typeof packet !== "object" || Array.isArray(packet) ||
        packet.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
      return {
        ok: false,
        versionError: true,
        message: "This packet was made by a different version of the Management App (this app reads packet version " +
          SUPPORTED_SCHEMA_VERSION + "). Ask for a packet made for this app."
      };
    }

    var schemaResult = g.PacketSchemaValidator.validateAgainstSchema(packet, schema);
    var relational = schemaResult.ok ? secondPass(packet) : [];
    var errors = schemaResult.errors.concat(relational);

    if (errors.length > 0) return { ok: false, errors: errors };
    return { ok: true, packet: packet };
  }

  g.ImportCore = {
    parseAndValidate: parseAndValidate,
    secondPass: secondPass,
    CANON_BLOCKS: CANON_BLOCKS,
    SUPPORTED_SCHEMA_VERSION: SUPPORTED_SCHEMA_VERSION
  };
})(typeof window !== "undefined" ? window : globalThis);


