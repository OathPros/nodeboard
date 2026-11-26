import schema from '../../../.nodeboard-v2/contracts/snapshot.schema.json' with { type: 'json' };

// These conservative provisional budgets are not a transport or publication policy.
const MAX_DEPTH = 64;
const MAX_VALUES = 100000;
const MAX_BYTES = 5000000;
const MAX_DIAGNOSTICS = 1000;
const MAX_PATTERN_WORK = 1000000;
const DIAGNOSTIC_LIMIT = Symbol('diagnostic limit');
const SCHEMA_MISMATCH = Symbol('schema mismatch');
const PATTERN_LIMIT = Symbol('pattern limit');
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const pointer = (base, part) => `${base}/${String(part).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonicalJson = value => JSON.stringify(value, (key, entry) =>
  isObject(entry) ? Object.fromEntries(Object.keys(entry).sort().map(name => [name, entry[name]])) : entry);
const limitation = {
  code: 'VALIDATION_INCOMPLETE', severity: 'warning', path: '',
  message: 'Structural checks cover the current draft schema keywords, not arbitrary schemas. Constraint variants, relationship property applicability, external ID uniqueness, duplicate assertion context, authorization, and publication rules remain incomplete.'
};

function validDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  return y >= 1 && month >= 1 && month <= 12 && day >= 1 &&
    day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function validDateTime(value) {
  const m = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value);
  return !!m && validDate(m[1]) && Number(m[2]) <= 23 && Number(m[3]) <= 59 &&
    Number(m[4]) <= 59 && (!m[5] || (Number(m[6]) <= 23 && Number(m[7]) <= 59));
}

function dateTimeAfter(left, right) {
  const parts = value => {
    const match = /^(.{19})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/.exec(value);
    return { seconds: Date.parse(match[1] + match[3]), fraction: match[2] || '' };
  };
  const a = parts(left), b = parts(right);
  if (a.seconds !== b.seconds) return a.seconds > b.seconds;
  for (let i = 0; i < Math.max(a.fraction.length, b.fraction.length); i++) {
    const x = a.fraction.charCodeAt(i) || 48, y = b.fraction.charCodeAt(i) || 48;
    if (x !== y) return x > y;
  }
  return false;
}

function inspectInput(input, diagnostics) {
  let count = 0, serializedBytes = 0;
  const encoder = new TextEncoder(), ancestors = new Set();
  const stack = [{ value: input, path: '', depth: 0 }];
  while (stack.length) {
    const item = stack.pop(), { value, path, depth } = item;
    if (item.exit) { ancestors.delete(value); continue; }
    if (++count > MAX_VALUES || depth > MAX_DEPTH) {
      diagnostics.push({ code: 'RESOURCE_LIMIT_EXCEEDED', severity: 'error', path, message: 'JSON input exceeds the provisional depth or value limit.' });
      return false;
    }
    const addSerialized = length => {
      serializedBytes += length;
      return serializedBytes <= MAX_BYTES;
    };
    if (typeof value === 'string' && value.length > MAX_BYTES) {
      diagnostics.push({ code: 'RESOURCE_LIMIT_EXCEEDED', severity: 'error', path, message: 'Serialized JSON exceeds the provisional byte limit.' });
      return false;
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0))) {
      const encoded = JSON.stringify(value);
      if (!addSerialized(typeof value === 'string' ? encoder.encode(encoded).length : encoded.length)) {
        diagnostics.push({ code: 'RESOURCE_LIMIT_EXCEEDED', severity: 'error', path, message: 'Serialized JSON exceeds the provisional byte limit.' });
        return false;
      }
      continue;
    }
    if (typeof value !== 'object') {
      diagnostics.push({ code: 'INVALID_STRUCTURE', severity: 'error', path, message: 'Value is not JSON-compatible.' });
      return false;
    }
    if (ancestors.has(value)) {
      diagnostics.push({ code: 'INVALID_STRUCTURE', severity: 'error', path, message: 'Cyclic input is not JSON-compatible.' });
      return false;
    }
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) {
      diagnostics.push({ code: 'INVALID_STRUCTURE', severity: 'error', path, message: 'Only plain JSON objects and arrays are permitted.' });
      return false;
    }
    ancestors.add(value);
    stack.push({ value, exit: true });
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key === 'symbol')) {
      diagnostics.push({ code: 'INVALID_STRUCTURE', severity: 'error', path, message: 'Symbol keys are not JSON-compatible.' });
      return false;
    }
    const dataKeys = array ? keys.filter(key => key !== 'length') : keys;
    if (dataKeys.length > MAX_VALUES - count) {
      diagnostics.push({ code: 'RESOURCE_LIMIT_EXCEEDED', severity: 'error', path, message: 'JSON input exceeds the provisional value limit.' });
      return false;
    }
    if (array && (dataKeys.length !== descriptors.length.value ||
        dataKeys.some(key => !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= descriptors.length.value))) {
      diagnostics.push({ code: 'INVALID_STRUCTURE', severity: 'error', path, message: 'Sparse arrays and arrays with extra keys are not permitted.' });
      return false;
    }
    if (!addSerialized(2 + Math.max(0, dataKeys.length - 1))) {
      diagnostics.push({ code: 'RESOURCE_LIMIT_EXCEEDED', severity: 'error', path, message: 'Serialized JSON exceeds the provisional byte limit.' });
      return false;
    }
    for (let i = dataKeys.length - 1; i >= 0; i--) {
      const key = dataKeys[i], childPath = pointer(path, key), descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        diagnostics.push({ code: 'INVALID_STRUCTURE', severity: 'error', path: childPath, message: 'Non-enumerable or accessor properties are not JSON-compatible.' });
        return false;
      }
      if (key.length > MAX_BYTES) {
        diagnostics.push({ code: 'RESOURCE_LIMIT_EXCEEDED', severity: 'error', path, message: 'Serialized JSON exceeds the provisional byte limit.' });
        return false;
      }
      if (!array && !addSerialized(encoder.encode(JSON.stringify(key)).length + 1)) {
        diagnostics.push({ code: 'RESOURCE_LIMIT_EXCEEDED', severity: 'error', path: childPath, message: 'Serialized JSON exceeds the provisional byte limit.' });
        return false;
      }
      if (unsafeKeys.has(key)) {
        if (diagnostics.length >= MAX_DIAGNOSTICS) {
          diagnostics.push({ code: 'RESOURCE_LIMIT_EXCEEDED', severity: 'error', path: '', message: 'Input exceeds the provisional diagnostic limit.' });
          return false;
        }
        diagnostics.push({ code: 'UNSAFE_PROPERTY_KEY', severity: 'error', path: childPath, message: 'Unsafe object key is not permitted.' });
      }
      stack.push({ value: descriptor.value, path: childPath, depth: depth + 1 });
    }
  }
  return true;
}

// Reject schema evolution that this deliberately small interpreter cannot honor.
function supportsSchema(root) {
  const keywords = new Set(['$schema', '$id', '$defs', '$ref', 'title', 'type', 'properties',
    'required', 'additionalProperties', 'items', 'uniqueItems', 'minItems', 'minLength', 'maxLength', 'pattern',
    'format', 'minimum', 'maximum', 'exclusiveMinimum', 'const', 'enum', 'anyOf', 'allOf', 'if', 'then']);
  const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
  const primitive = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
  if (!isObject(root) || root.$schema !== 'https://json-schema.org/draft/2020-12/schema' || !isObject(root.$defs)) return false;
  const active = new WeakSet(), completed = new WeakSet();
  function visit(rule, refs = new Set(), isRoot = false) {
    if (refs.size || !isObject(rule)) return check(rule, refs, isRoot);
    if (active.has(rule) || completed.has(rule)) return true;
    active.add(rule);
    const result = check(rule, refs, isRoot);
    active.delete(rule);
    if (result) completed.add(rule);
    return result;
  }
  function check(rule, refs = new Set(), isRoot = false) {
    if (!isObject(rule) || Object.keys(rule).some(key => !keywords.has(key))) return false;
    if (!isRoot && ('$defs' in rule || '$schema' in rule || '$id' in rule)) return false;
    if (rule.$ref !== undefined) {
      if (Object.keys(rule).length !== 1 || typeof rule.$ref !== 'string' || !/^#\/\$defs\/[^/]+$/.test(rule.$ref)) return false;
      const name = rule.$ref.slice('#/$defs/'.length);
      if (!Object.hasOwn(root.$defs, name) || refs.has(name)) return false;
      const next = new Set(refs); next.add(name);
      return visit(root.$defs[name], next);
    }
    if (rule.type !== undefined) {
      const values = Array.isArray(rule.type) ? rule.type : [rule.type];
      if (!values.length || values.some(type => !types.has(type))) return false;
    }
    if (rule.const !== undefined && !primitive(rule.const)) return false;
    if (rule.enum !== undefined && (!Array.isArray(rule.enum) || !rule.enum.length || rule.enum.some(value => !primitive(value)))) return false;
    if (rule.required !== undefined && (!Array.isArray(rule.required) || rule.required.some(key => typeof key !== 'string'))) return false;
    if (rule.uniqueItems !== undefined && typeof rule.uniqueItems !== 'boolean') return false;
    for (const key of ['minItems', 'minLength', 'maxLength']) if (rule[key] !== undefined && (!Number.isSafeInteger(rule[key]) || rule[key] < 0)) return false;
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum']) if (rule[key] !== undefined && (typeof rule[key] !== 'number' || !Number.isFinite(rule[key]))) return false;
    if (rule.format !== undefined && rule.format !== 'date-time') return false;
    if (rule.pattern !== undefined) {
      if (typeof rule.pattern !== 'string') return false;
      try { new RegExp(rule.pattern); } catch { return false; }
    }
    if (rule.properties !== undefined && (!isObject(rule.properties) || Object.values(rule.properties).some(child => !visit(child)))) return false;
    if (rule.items !== undefined && !visit(rule.items)) return false;
    if (rule.additionalProperties !== undefined && typeof rule.additionalProperties !== 'boolean' && !visit(rule.additionalProperties)) return false;
    for (const key of ['anyOf', 'allOf']) {
      if (rule[key] !== undefined && (!Array.isArray(rule[key]) || !rule[key].length || rule[key].some(child => !visit(child, refs)))) return false;
    }
    if (rule.if !== undefined && !visit(rule.if, refs)) return false;
    if (rule.then !== undefined && (rule.if === undefined || !visit(rule.then, refs))) return false;
    return true;
  }
  return visit(root, new Set(), true) && Object.values(root.$defs).every(def => visit(def));
}

// Implements the keywords used by the current structural draft without runtime code generation.
function matchesSchema(rule, value, path) {
  try {
    checkSchema(rule, value, path, [], true);
    return true;
  } catch (error) {
    if (error === SCHEMA_MISMATCH) return false;
    throw error;
  }
}

function checkSchema(rule, value, path, errors, probe = false) {
  if (rule.$ref) return checkSchema(schema.$defs[rule.$ref.slice('#/$defs/'.length)], value, path, errors, probe);
  const fail = (at = path) => {
    if (probe) throw SCHEMA_MISMATCH;
    if (errors.length >= MAX_DIAGNOSTICS) throw DIAGNOSTIC_LIMIT;
    errors.push({ code: 'INVALID_STRUCTURE', severity: 'error', path: at, message: 'Value does not satisfy the snapshot structural contract.' });
  };
  if (rule.anyOf) {
    if (!rule.anyOf.some(option => matchesSchema(option, value, path))) fail();
  }
  if (rule.const !== undefined && value !== rule.const) fail();
  if (rule.enum && !rule.enum.includes(value)) fail();
  if (rule.type) {
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    const matches = type => type === 'null' ? value === null :
      type === 'object' ? isObject(value) : type === 'array' ? Array.isArray(value) :
      type === 'number' ? typeof value === 'number' && Number.isFinite(value) :
      type === 'integer' ? Number.isInteger(value) : typeof value === type;
    if (!types.some(matches)) { fail(); return; }
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if ((rule.minLength !== undefined && length < rule.minLength) ||
        (rule.maxLength !== undefined && length > rule.maxLength) ||
        (rule.pattern && !new RegExp(rule.pattern).test(value)) ||
        (rule.format === 'date-time' && !validDateTime(value))) fail();
  }
  if (typeof value === 'number' && ((rule.minimum !== undefined && value < rule.minimum) ||
      (rule.maximum !== undefined && value > rule.maximum) ||
      (rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum))) fail();
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) fail();
    if (rule.uniqueItems && new Set(value.map(canonicalJson)).size !== value.length) fail();
    if (rule.items) value.forEach((item, index) => checkSchema(rule.items, item, pointer(path, index), errors, probe));
  }
  if (isObject(value)) {
    for (const key of rule.required || []) if (!Object.hasOwn(value, key)) fail(pointer(path, key));
    for (const key of Object.keys(value)) {
      if (rule.properties && Object.hasOwn(rule.properties, key)) checkSchema(rule.properties[key], value[key], pointer(path, key), errors, probe);
      else if (rule.additionalProperties === false) fail(pointer(path, key));
      else if (isObject(rule.additionalProperties)) checkSchema(rule.additionalProperties, value[key], pointer(path, key), errors, probe);
    }
  }
  for (const part of rule.allOf || []) checkSchema(part, value, path, errors, probe);
  if (rule.if && matchesSchema(rule.if, value, path) && rule.then) checkSchema(rule.then, value, path, errors, probe);
}

function typedValue(value, type, definition) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isSafeInteger(value);
    case 'decimal': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'date': return typeof value === 'string' && validDate(value);
    case 'datetime': return typeof value === 'string' && validDateTime(value);
    case 'uri':
      if (typeof value !== 'string') return false;
      try { return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !!new URL(value); } catch { return false; }
    case 'list': return Array.isArray(value) && value.every(item => typedValue(item, definition.listItemType, definition));
    case 'structured': return isObject(value);
    case 'enum': return typeof value === 'string' && definition.enumValues.includes(value);
    default: return false;
  }
}

function compileGlob(pattern) {
  const characters = Array.from(pattern), tokens = [];
  for (let i = 0; i < characters.length; i++) {
    const character = characters[i];
    if (character === '\\') {
      if (++i === characters.length) return null;
      tokens.push({ type: 'literal', value: characters[i] });
    } else if (character === '*') {
      if (tokens[tokens.length - 1]?.type !== 'star') tokens.push({ type: 'star' });
    } else if (character === '?') tokens.push({ type: 'any' });
    else tokens.push({ type: 'literal', value: character });
  }
  return tokens;
}

function checkSemantics(snapshot, diagnostics, profile) {
  const add = (code, severity, path, message, entityId, suggestion) => {
    if (diagnostics.length >= MAX_DIAGNOSTICS) throw DIAGNOSTIC_LIMIT;
    const diagnostic = { code, severity, path, message };
    if (entityId) diagnostic.entityId = entityId;
    if (suggestion) diagnostic.suggestion = suggestion;
    diagnostics.push(diagnostic);
  };
  const index = (list, path, field = 'id') => {
    const map = new Map();
    list.forEach((item, i) => {
      const key = item[field];
      if (map.has(key)) add('DUPLICATE_ID', 'error', pointer(pointer(path, i), field), 'Identifier is duplicated in its namespace.');
      else map.set(key, item);
    });
    return map;
  };
  const { classes, relationshipTypes, propertyDefinitions, constraints } = snapshot.ontology;
  const { entities, relationships } = snapshot.graph;
  const classMap = index(classes, '/ontology/classes');
  const typeMap = index(relationshipTypes, '/ontology/relationshipTypes');
  const propertyMap = index(propertyDefinitions, '/ontology/propertyDefinitions');
  index(constraints, '/ontology/constraints');
  const entityMap = index(entities, '/graph/entities');
  index(relationships, '/graph/relationships');
  index(snapshot.views, '/views');
  index(relationshipTypes, '/ontology/relationshipTypes', 'predicate');

  const reference = (id, map, path, entityId) => {
    if (!map.has(id)) add('REFERENCE_NOT_FOUND', 'error', path, 'Referenced identifier does not exist.', entityId);
  };
  const references = (ids, map, path, entityId) => ids.forEach((id, i) => reference(id, map, pointer(path, i), entityId));
  classes.forEach((item, i) => {
    const path = `/ontology/classes/${i}`;
    references(item.superclassIds, classMap, `${path}/superclassIds`);
    references(item.propertyDefinitionIds, propertyMap, `${path}/propertyDefinitionIds`);
  });
  relationshipTypes.forEach((item, i) => {
    const path = `/ontology/relationshipTypes/${i}`;
    references(item.domainClassIds, classMap, `${path}/domainClassIds`);
    references(item.rangeClassIds, classMap, `${path}/rangeClassIds`);
    if (item.inversePredicateId !== null) reference(item.inversePredicateId, typeMap, `${path}/inversePredicateId`);
  });
  const requiredByClass = new Map(), cardinalityByClass = new Map(), uniquenessByClass = new Map(), conditionalByClass = new Map(), patternsByClass = new Map(), relationshipCounts = new Map(), allowedTargets = new Map(), disjointness = [], acyclic = [];
  constraints.forEach((item, i) => {
    const path = `/ontology/constraints/${i}`;
    if (item.kind === 'pattern') {
      const { classId, propertyId, pattern } = item.parameters;
      reference(classId, classMap, `${path}/parameters/classId`);
      reference(propertyId, propertyMap, `${path}/parameters/propertyId`);
      const definition = propertyMap.get(propertyId), tokens = compileGlob(pattern);
      if (!tokens) add('INVALID_CONSTRAINT', 'error', `${path}/parameters/pattern`, 'A glob escape must have a following character.');
      if (definition && !['string', 'enum', 'uri', 'date', 'datetime'].includes(definition.dataType)) {
        add('INVALID_CONSTRAINT', 'error', `${path}/parameters/propertyId`, 'A glob constraint requires a string-valued property.');
      } else if (tokens && classMap.has(classId) && definition) {
        if (!patternsByClass.has(classId)) patternsByClass.set(classId, []);
        patternsByClass.get(classId).push({ propertyId, tokens, path });
      }
      return;
    }
    if (item.kind === 'conditional') {
      const { classId, when, requirePropertyIds } = item.parameters;
      reference(classId, classMap, `${path}/parameters/classId`);
      reference(when.propertyId, propertyMap, `${path}/parameters/when/propertyId`);
      references(requirePropertyIds, propertyMap, `${path}/parameters/requirePropertyIds`);
      const conditionProperty = propertyMap.get(when.propertyId);
      if (conditionProperty && !typedValue(when.equals, conditionProperty.dataType, conditionProperty)) {
        add('INVALID_CONSTRAINT', 'error', `${path}/parameters/when/equals`, 'Conditional comparison does not match the property type.');
      } else if (classMap.has(classId) && conditionProperty && requirePropertyIds.every(id => propertyMap.has(id))) {
        if (!conditionalByClass.has(classId)) conditionalByClass.set(classId, []);
        conditionalByClass.get(classId).push({
          propertyId: when.propertyId, expected: canonicalJson(when.equals), requirePropertyIds, path,
        });
      }
      return;
    }
    if (item.kind === 'allowedTarget') {
      const { classId, relationshipTypeId, targetClassIds } = item.parameters;
      reference(classId, classMap, `${path}/parameters/classId`);
      reference(relationshipTypeId, typeMap, `${path}/parameters/relationshipTypeId`);
      references(targetClassIds, classMap, `${path}/parameters/targetClassIds`);
      if (classMap.has(classId) && typeMap.has(relationshipTypeId) && targetClassIds.every(id => classMap.has(id))) {
        if (!allowedTargets.has(relationshipTypeId)) allowedTargets.set(relationshipTypeId, new Map());
        const byClass = allowedTargets.get(relationshipTypeId);
        if (!byClass.has(classId)) byClass.set(classId, []);
        byClass.get(classId).push({ targetClassIds, path });
      }
      return;
    }
    if (item.kind === 'acyclic') {
      const { relationshipTypeId } = item.parameters;
      reference(relationshipTypeId, typeMap, `${path}/parameters/relationshipTypeId`);
      if (typeMap.has(relationshipTypeId)) acyclic.push({ relationshipTypeId, path });
      return;
    }
    if (item.kind === 'disjointness') {
      references(item.parameters.classIds, classMap, `${path}/parameters/classIds`);
      if (item.parameters.classIds.every(classId => classMap.has(classId))) {
        disjointness.push({ classIds: item.parameters.classIds, path });
      }
      return;
    }
    if (item.kind === 'uniqueness') {
      const { classId, propertyId } = item.parameters;
      reference(classId, classMap, `${path}/parameters/classId`);
      reference(propertyId, propertyMap, `${path}/parameters/propertyId`);
      if (classMap.has(classId) && propertyMap.has(propertyId)) {
        if (!uniquenessByClass.has(classId)) uniquenessByClass.set(classId, []);
        uniquenessByClass.get(classId).push({ propertyId, path, values: new Map() });
      }
      return;
    }
    if (item.kind === 'cardinality') {
      const { classId, relationshipTypeId, minimum, maximum } = item.parameters;
      reference(classId, classMap, `${path}/parameters/classId`);
      reference(relationshipTypeId, typeMap, `${path}/parameters/relationshipTypeId`);
      if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
        add('INVALID_CONSTRAINT', 'error', `${path}/parameters`, 'Cardinality minimum exceeds maximum.');
      } else if (classMap.has(classId) && typeMap.has(relationshipTypeId)) {
        if (!cardinalityByClass.has(classId)) cardinalityByClass.set(classId, []);
        cardinalityByClass.get(classId).push({ ...item.parameters, path });
      }
      return;
    }
    if (item.kind !== 'required') {
      add('UNSUPPORTED_CONSTRAINT', profile === 'publish' ? 'error' : 'warning', `${path}/kind`, 'This configured constraint kind is not implemented.');
      return;
    }
    const { classId, propertyId } = item.parameters;
    reference(classId, classMap, `${path}/parameters/classId`);
    reference(propertyId, propertyMap, `${path}/parameters/propertyId`);
    if (classMap.has(classId) && propertyMap.has(propertyId)) {
      if (!requiredByClass.has(classId)) requiredByClass.set(classId, new Set());
      requiredByClass.get(classId).add(propertyId);
    }
  });
  if (cardinalityByClass.size) {
    for (const item of relationships) {
      if (item.status !== 'asserted' || item.relationshipTypeId === null) continue;
      if (!relationshipCounts.has(item.relationshipTypeId)) relationshipCounts.set(item.relationshipTypeId, { in: new Map(), out: new Map() });
      const counts = relationshipCounts.get(item.relationshipTypeId);
      counts.out.set(item.from, (counts.out.get(item.from) || 0) + 1);
      counts.in.set(item.to, (counts.in.get(item.to) || 0) + 1);
    }
  }

  const colors = new Map(), classIndexes = new Map();
  classes.forEach((item, i) => { if (!classIndexes.has(item.id)) classIndexes.set(item.id, i); });
  classes.forEach(item => {
    if (colors.has(item.id)) return;
    const stack = [{ id: item.id, next: 0 }];
    colors.set(item.id, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1], parents = classMap.get(frame.id).superclassIds;
      if (frame.next === parents.length) { colors.set(frame.id, 2); stack.pop(); continue; }
      const parent = parents[frame.next++];
      if (!classMap.has(parent)) continue;
      if (colors.get(parent) === 1) add('INHERITANCE_CYCLE', 'error', `/ontology/classes/${classIndexes.get(frame.id)}/superclassIds/${frame.next - 1}`, 'Class inheritance contains a cycle.');
      else if (!colors.has(parent)) { colors.set(parent, 1); stack.push({ id: parent, next: 0 }); }
    }
  });

  const properties = (item, path) => {
    for (const key of Object.keys(item.properties)) {
      const propertyPath = pointer(`${path}/properties`, key), definition = propertyMap.get(key);
      if (!definition) add('UNSAFE_PROPERTY_KEY', 'error', propertyPath, 'Property key is not a defined property identifier.', item.id);
      else if (!typedValue(item.properties[key], definition.dataType, definition)) add('INVALID_PROPERTY_VALUE', 'error', propertyPath, 'Property value does not match its defined type.', item.id);
    }
  };
  const provenance = (item, path) => {
    item.provenance.forEach((source, i) => {
      if (source.validFrom !== undefined && source.validUntil !== undefined &&
          dateTimeAfter(source.validFrom, source.validUntil)) {
        add('INVALID_TEMPORAL_RANGE', 'error', `${path}/provenance/${i}/validUntil`, 'Validity ends before it starts.', item.id);
      }
    });
  };
  let patternWork = 0;
  const globMatches = (value, tokens) => {
    patternWork += (value.length + 1) * (tokens.length + 1);
    if (patternWork > MAX_PATTERN_WORK) throw PATTERN_LIMIT;
    const characters = Array.from(value);
    let previous = new Uint8Array(characters.length + 1);
    previous[0] = 1;
    for (const token of tokens) {
      const next = new Uint8Array(characters.length + 1);
      if (token.type === 'star') next[0] = previous[0];
      for (let i = 1; i <= characters.length; i++) {
        next[i] = token.type === 'star'
          ? previous[i] || next[i - 1]
          : previous[i - 1] && (token.type === 'any' || token.value === characters[i - 1]);
      }
      previous = next;
    }
    return previous[characters.length] === 1;
  };
  entities.forEach((item, i) => {
    const path = `/graph/entities/${i}`;
    references(item.classIds, classMap, `${path}/classIds`, item.id);
    item.classIds.forEach((id, classIndex) => {
      if (classMap.get(id)?.abstract) {
        add('ABSTRACT_CLASS_INSTANTIATION', 'error', `${path}/classIds/${classIndex}`, 'An abstract class cannot be directly instantiated.', item.id);
      }
    });
    properties(item, path);
    provenance(item, path);
    const applicable = new Set(), required = new Set(), cardinality = [], uniqueness = [], conditional = [], patterns = [], seen = new Set(), pending = [...item.classIds];
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const cls = classMap.get(id);
      if (cls) {
        for (const propertyId of cls.propertyDefinitionIds) applicable.add(propertyId);
        for (const propertyId of requiredByClass.get(id) || []) required.add(propertyId);
        cardinality.push(...(cardinalityByClass.get(id) || []));
        uniqueness.push(...(uniquenessByClass.get(id) || []));
        conditional.push(...(conditionalByClass.get(id) || []));
        patterns.push(...(patternsByClass.get(id) || []));
        pending.push(...cls.superclassIds);
      }
    }
    for (const propertyId of required) {
      if (!Object.hasOwn(item.properties, propertyId)) {
        add('CONSTRAINT_VIOLATION', profile === 'publish' ? 'error' : 'warning', pointer(`${path}/properties`, propertyId), 'Required property is missing for an entity class or ancestor.', item.id);
      }
    }
    for (const constraint of cardinality) {
      const counts = relationshipCounts.get(constraint.relationshipTypeId);
      const count = counts ? counts[constraint.direction].get(item.id) || 0 : 0;
      if ((constraint.minimum !== undefined && count < constraint.minimum) ||
          (constraint.maximum !== undefined && count > constraint.maximum)) {
        add('CONSTRAINT_VIOLATION', profile === 'publish' ? 'error' : 'warning', path, 'Asserted relationship cardinality violates a configured constraint.', item.id, `Review ${constraint.path}.`);
      }
    }
    for (const constraint of uniqueness) {
      if (!Object.hasOwn(item.properties, constraint.propertyId)) continue;
      const canonical = canonicalJson(item.properties[constraint.propertyId]);
      if (constraint.values.has(canonical)) {
        const first = constraint.values.get(canonical);
        add('CONSTRAINT_VIOLATION', profile === 'publish' ? 'error' : 'warning',
          pointer(`${path}/properties`, constraint.propertyId), 'Property value violates a configured uniqueness constraint.',
          item.id, `Review ${constraint.path} and /graph/entities/${first}.`);
      } else constraint.values.set(canonical, i);
    }
    for (const constraint of conditional) {
      if (!Object.hasOwn(item.properties, constraint.propertyId) ||
          canonicalJson(item.properties[constraint.propertyId]) !== constraint.expected) continue;
      for (const propertyId of constraint.requirePropertyIds) {
        if (!Object.hasOwn(item.properties, propertyId)) {
          add('CONSTRAINT_VIOLATION', profile === 'publish' ? 'error' : 'warning',
            pointer(`${path}/properties`, propertyId), 'A conditionally required property is missing.',
            item.id, `Review ${constraint.path}.`);
        }
      }
    }
    for (const constraint of patterns) {
      if (!Object.hasOwn(item.properties, constraint.propertyId)) continue;
      const value = item.properties[constraint.propertyId];
      if (typeof value === 'string' && !globMatches(value, constraint.tokens)) {
        add('CONSTRAINT_VIOLATION', profile === 'publish' ? 'error' : 'warning',
          pointer(`${path}/properties`, constraint.propertyId), 'Property value does not match the configured glob.',
          item.id, `Review ${constraint.path}.`);
      }
    }
    for (const constraint of disjointness) {
      if (constraint.classIds.filter(classId => seen.has(classId)).length > 1) {
        add('CONSTRAINT_VIOLATION', profile === 'publish' ? 'error' : 'warning',
          `${path}/classIds`, 'Entity belongs to disjoint classes.', item.id, `Review ${constraint.path}.`);
      }
    }
    for (const key of Object.keys(item.properties)) {
      if (propertyMap.has(key) && !applicable.has(key)) {
        add('PROPERTY_NOT_APPLICABLE', 'warning', pointer(`${path}/properties`, key), 'Property is not declared by the entity classes or their ancestors.', item.id);
      }
    }
  });
  const matches = (entity, allowed) => {
    if (!allowed.length) return true;
    const seen = new Set(), pending = [...entity.classIds];
    while (pending.length) {
      const id = pending.pop();
      if (allowed.includes(id)) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const cls = classMap.get(id);
      if (cls) pending.push(...cls.superclassIds);
    }
    return false;
  };
  relationships.forEach((item, i) => {
    const path = `/graph/relationships/${i}`;
    reference(item.from, entityMap, `${path}/from`, item.id);
    reference(item.to, entityMap, `${path}/to`, item.id);
    properties(item, path);
    provenance(item, path);
    if (item.relationshipTypeId === null) {
      add('UNRESOLVED_LEGACY_RELATIONSHIP', profile === 'publish' ? 'error' : 'warning', `${path}/relationshipTypeId`, 'Legacy relationship has no resolved predicate.', item.id);
      return;
    }
    reference(item.relationshipTypeId, typeMap, `${path}/relationshipTypeId`, item.id);
    const type = typeMap.get(item.relationshipTypeId), from = entityMap.get(item.from), to = entityMap.get(item.to);
    if (type && from && !matches(from, type.domainClassIds)) add('DOMAIN_RANGE_MISMATCH', profile === 'publish' ? 'error' : 'warning', `${path}/from`, 'Relationship source does not match the predicate domain.', item.id);
    if (type && to && !matches(to, type.rangeClassIds)) add('DOMAIN_RANGE_MISMATCH', profile === 'publish' ? 'error' : 'warning', `${path}/to`, 'Relationship target does not match the predicate range.', item.id);
    const rules = allowedTargets.get(item.relationshipTypeId);
    if (item.status === 'asserted' && rules && from && to) {
      const seen = new Set(), pending = [...from.classIds];
      while (pending.length) {
        const id = pending.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        for (const constraint of rules.get(id) || []) {
          if (!matches(to, constraint.targetClassIds)) {
            add('CONSTRAINT_VIOLATION', profile === 'publish' ? 'error' : 'warning',
              `${path}/to`, 'Asserted relationship target is not an allowed class.', item.id, `Review ${constraint.path}.`);
          }
        }
        const cls = classMap.get(id);
        if (cls) pending.push(...cls.superclassIds);
      }
    }
  });
  if (acyclic.length) {
    const adjacencyByType = new Map();
    const constrainedTypes = new Set(acyclic.map(item => item.relationshipTypeId));
    relationships.forEach((item, index) => {
      if (item.status !== 'asserted' || !constrainedTypes.has(item.relationshipTypeId) ||
          !entityMap.has(item.from) || !entityMap.has(item.to)) return;
      if (!adjacencyByType.has(item.relationshipTypeId)) adjacencyByType.set(item.relationshipTypeId, new Map());
      const adjacency = adjacencyByType.get(item.relationshipTypeId);
      if (!adjacency.has(item.from)) adjacency.set(item.from, []);
      adjacency.get(item.from).push({ to: item.to, id: item.id, index });
    });
    const cyclesByType = new Map();
    for (const constraint of acyclic) {
      const adjacency = adjacencyByType.get(constraint.relationshipTypeId);
      if (!adjacency) continue;
      if (!cyclesByType.has(constraint.relationshipTypeId)) {
        const visited = new Map(), cycles = [];
        for (const start of adjacency.keys()) {
          if (visited.has(start)) continue;
          const stack = [{ id: start, next: 0 }];
          visited.set(start, 1);
          while (stack.length) {
            const frame = stack[stack.length - 1], edges = adjacency.get(frame.id) || [];
            if (frame.next === edges.length) {
              visited.set(frame.id, 2);
              stack.pop();
              continue;
            }
            const edge = edges[frame.next++];
            if (visited.get(edge.to) === 1) cycles.push(edge);
            else if (!visited.has(edge.to)) {
              visited.set(edge.to, 1);
              stack.push({ id: edge.to, next: 0 });
            }
          }
        }
        cyclesByType.set(constraint.relationshipTypeId, cycles);
      }
      for (const edge of cyclesByType.get(constraint.relationshipTypeId)) {
        add('CONSTRAINT_VIOLATION', profile === 'publish' ? 'error' : 'warning',
          `/graph/relationships/${edge.index}/to`, 'Asserted relationships contain a directed cycle.',
          edge.id, `Review ${constraint.path}.`);
      }
    }
  }
  snapshot.views.forEach((item, i) => {
    const path = `/views/${i}`;
    references(item.entityIds, entityMap, `${path}/entityIds`);
    for (const id of Object.keys(item.positions)) reference(id, entityMap, pointer(`${path}/positions`, id));
  });
}

export function inspectJsonInput(input) {
  const diagnostics = [];
  try {
    inspectInput(input, diagnostics);
  } catch {
    diagnostics.push({ code: 'INVALID_STRUCTURE', severity: 'error', path: '', message: 'Input could not be safely inspected as JSON.' });
  }
  diagnostics.sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code) ||
    compare(a.entityId || '', b.entityId || '') || compare(a.message, b.message));
  return diagnostics;
}

export function validateSnapshot(snapshot, options) {
  const diagnostics = [{ ...limitation }, ...inspectJsonInput(snapshot)];
  let profile = 'draft', validProfile = options === undefined;
  if (!validProfile) {
    try {
      if (isObject(options) && inspectJsonInput(options).length === 0 &&
          Object.keys(options).length === 1 && Object.hasOwn(options, 'profile')) {
        profile = options.profile;
        validProfile = profile === 'draft' || profile === 'publish';
      }
    } catch { /* Invalid profile options must not be used. */ }
  }
  if (!validProfile) {
    diagnostics.push({ code: 'INVALID_PROFILE', severity: 'error', path: '', message: 'Validation options must specify only a draft or publish profile.' });
  } else if (profile === 'publish') {
    diagnostics.push({ code: 'PUBLISH_POLICY_INCOMPLETE', severity: 'error', path: '', message: 'Publication is blocked because the publication policy is incomplete.' });
  }
  let supported = false;
  try { supported = supportsSchema(schema); } catch { /* Fail closed on an invalid schema. */ }
  if (!supported) {
    diagnostics.push({ code: 'UNSUPPORTED_SCHEMA', severity: 'error', path: '', message: 'The snapshot schema uses unsupported or invalid validation rules.' });
  } else if (!diagnostics.some(d => d.severity === 'error' && d.code !== 'UNSAFE_PROPERTY_KEY' && d.code !== 'PUBLISH_POLICY_INCOMPLETE')) {
    try {
      const beforeStructural = diagnostics.length;
      checkSchema(schema, snapshot, '', diagnostics);
      if (diagnostics.length === beforeStructural) checkSemantics(snapshot, diagnostics, profile);
    } catch (error) {
      diagnostics.push(error === DIAGNOSTIC_LIMIT
        ? { code: 'RESOURCE_LIMIT_EXCEEDED', severity: 'error', path: '', message: 'Input exceeds the provisional diagnostic limit.' }
        : error === PATTERN_LIMIT
          ? { code: 'RESOURCE_LIMIT_EXCEEDED', severity: 'error', path: '', message: 'Pattern validation exceeds the provisional work limit.' }
          : { code: 'INVALID_STRUCTURE', severity: 'error', path: '', message: 'Input could not be safely validated.' });
    }
  }
  diagnostics.sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code) ||
    compare(a.entityId || '', b.entityId || '') || compare(a.message, b.message));
  return diagnostics;
}
