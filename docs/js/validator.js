// validator.js — a small hand-written validator that walks packet_schema.json
// at runtime. Implements exactly the Draft-07 subset the schema uses
// (TDS §4 keyword table; Architecture Evaluation §6):
//   $ref/definitions, type, properties, items, required,
//   additionalProperties:false, enum, const, pattern, minimum, minLength, oneOf.
// `format` is deliberately NOT implemented (annotation, not assertion).
//
// Three traps this code is written to survive (TDS §4):
//   1. `required` is both a keyword and a property NAME. Keywords are only ever
//      read off the schema node itself (schema.required as an array); the map in
//      schema.properties is only ever descended into, never scanned for keywords.
//   2. additionalProperties:false inside a oneOf branch is evaluated per branch,
//      against that branch's own `properties` only.
//   3. A oneOf branch carries no `type` of its own — a subschema with `properties`
//      or `required` is treated as an object even when `type` is absent, so a
//      malformed payload can never silently pass.

(function (g) {
  "use strict";

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  // Resolve a local "#/definitions/..." pointer against the root schema.
  function resolveRef(ref, root) {
    if (ref.indexOf("#/") !== 0) {
      throw new Error("Unsupported $ref (only local #/ pointers): " + ref);
    }
    var parts = ref.slice(2).split("/");
    var node = root;
    for (var i = 0; i < parts.length; i++) {
      node = node[parts[i]];
      if (node === undefined) throw new Error("Unresolvable $ref: " + ref);
    }
    return node;
  }

  // Trap 3: infer object-ness when `type` is absent but the shape is an object schema.
  function effectiveType(schema) {
    if (typeof schema.type === "string") return schema.type;
    if ("properties" in schema || "required" in schema || "additionalProperties" in schema) {
      return "object";
    }
    return null; // e.g. a { "const": "pageRange" } leaf — no structural type
  }

  function typeMatches(type, value) {
    switch (type) {
      case "object": return isPlainObject(value);
      case "array": return Array.isArray(value);
      case "string": return typeof value === "string";
      case "boolean": return typeof value === "boolean";
      case "integer": return typeof value === "number" && Number.isInteger(value);
      case "number": return typeof value === "number";
      default: return true;
    }
  }

  // Walk one node. Pushes plain-language messages onto `errors`.
  function walk(value, schema, root, path, errors) {
    // $ref replaces the schema (Draft-07: siblings of $ref are ignored; our schema
    // never puts siblings alongside a $ref, so this is exact).
    if (schema.$ref) {
      return walk(value, resolveRef(schema.$ref, root), root, path, errors);
    }

    var type = effectiveType(schema);
    if (type !== null && !typeMatches(type, value)) {
      errors.push(at(path) + " must be " + type + ", got " + describe(value));
      return; // wrong type — deeper checks would be noise
    }

    if ("const" in schema && value !== schema.const) {
      errors.push(at(path) + " must equal " + JSON.stringify(schema.const));
    }
    if (schema.enum && schema.enum.indexOf(value) === -1) {
      errors.push(at(path) + " must be one of: " + schema.enum.join(", "));
    }

    if (type === "object") walkObject(value, schema, root, path, errors);
    else if (type === "array") walkArray(value, schema, root, path, errors);
    else if (typeof value === "string") walkString(value, schema, path, errors);
    else if (typeof value === "number") walkNumber(value, schema, path, errors);

    if (schema.oneOf) walkOneOf(value, schema.oneOf, root, path, errors);
  }

  function walkObject(value, schema, root, path, errors) {
    // required: read ONLY the schema-level array (trap 1).
    if (Array.isArray(schema.required)) {
      for (var i = 0; i < schema.required.length; i++) {
        var key = schema.required[i];
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push(at(path) + " is missing required field '" + key + "'");
        }
      }
    }
    var props = schema.properties || {};
    // additionalProperties:false — reject any key the schema doesn't name.
    if (schema.additionalProperties === false) {
      for (var k in value) {
        if (Object.prototype.hasOwnProperty.call(value, k) && !(k in props)) {
          errors.push(at(path) + " has unexpected field '" + k + "'");
        }
      }
    }
    // Descend into each named property that is present.
    for (var name in props) {
      if (Object.prototype.hasOwnProperty.call(value, name)) {
        walk(value[name], props[name], root, join(path, name), errors);
      }
    }
  }

  function walkArray(value, schema, root, path, errors) {
    if (schema.items) {
      for (var i = 0; i < value.length; i++) {
        walk(value[i], schema.items, root, path + "[" + i + "]", errors);
      }
    }
  }

  function walkString(value, schema, path, errors) {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(at(path) + " must be a non-empty string");
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(at(path) + " has the wrong format (\"" + value + "\")");
    }
  }

  function walkNumber(value, schema, path, errors) {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(at(path) + " must be at least " + schema.minimum);
    }
  }

  // oneOf: value must satisfy EXACTLY one branch. Each branch is validated in
  // isolation (trap 2: its own additionalProperties:false against its own props).
  function walkOneOf(value, branches, root, path, errors) {
    var matched = 0;
    for (var i = 0; i < branches.length; i++) {
      var branchErrors = [];
      walk(value, branches[i], root, path, branchErrors);
      if (branchErrors.length === 0) matched++;
    }
    if (matched !== 1) {
      errors.push(at(path) + " does not match any allowed shape for its 'kind'");
    }
  }

  function describe(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "an array";
    return typeof value;
  }
  function at(path) { return path || "the packet"; }
  function join(path, name) { return path ? path + "." + name : name; }

  // Public entry: returns { ok, errors:[...] }.
  function validateAgainstSchema(data, schema) {
    var errors = [];
    walk(data, schema, schema, "", errors);
    return { ok: errors.length === 0, errors: errors };
  }

  g.PacketSchemaValidator = { validateAgainstSchema: validateAgainstSchema };
})(typeof window !== "undefined" ? window : globalThis);


