import { inspectJsonInput, validateSnapshot } from './validate-v2.js';

const ID = /^[A-Za-z0-9_-]{1,120}$(?![\s\S])/;
const MAX_BYTES = 5000000;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const own = (value, key) => isRecord(value) && Object.hasOwn(value, key);

function diagnostic(code, severity, path, message, suggestion) {
  const result = { code, severity, path, message };
  if (suggestion) result.suggestion = suggestion;
  return result;
}

function sortDiagnostics(diagnostics) {
  return diagnostics.sort((a, b) =>
    compare(a.path || '', b.path || '') ||
    compare(a.code || '', b.code || '') ||
    compare(a.entityId || '', b.entityId || '') ||
    compare(a.message || '', b.message || ''));
}

function slug(value) {
  const result = String(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return result || 'UNNAMED';
}

function hash(value) {
  let result = 2166136261;
  for (const character of value) {
    result ^= character.codePointAt(0);
    result = Math.imul(result, 16777619) >>> 0;
  }
  return result.toString(36);
}

function uniqueId(candidate, used) {
  const bounded = candidate.slice(0, 120);
  let id = bounded, suffix = 2;
  while (used.has(id)) id = `${bounded.slice(0, 120 - String(suffix).length - 1)}-${suffix++}`;
  used.add(id);
  return id;
}

function boundedToken(prefix, label, digest, used) {
  const suffix = `-${digest}`;
  const available = Math.max(1, 120 - prefix.length - suffix.length);
  return uniqueId(`${prefix}${label.slice(0, available)}${suffix}`, used);
}

function sourceFields(value, known) {
  if (!isRecord(value)) return {};
  const result = {};
  for (const [key, field] of Object.entries(value)) if (!known.has(key)) result[key] = clone(field);
  return result;
}

function inputAndBackup(input, diagnostics) {
  let parsed = input;
  if (typeof input === 'string') {
    if (input.length > MAX_BYTES || new TextEncoder().encode(input).length > MAX_BYTES) {
      diagnostics.push(diagnostic('RESOURCE_LIMIT_EXCEEDED', 'error', '', 'The legacy JSON source exceeds the provisional byte limit.'));
      return null;
    }
    try { parsed = JSON.parse(input); }
    catch { diagnostics.push(diagnostic('INVALID_STRUCTURE', 'error', '', 'The legacy source is not valid JSON.')); return null; }
  }
  const inspected = inspectJsonInput(parsed);
  diagnostics.push(...inspected);
  if (inspected.some(item => item.severity === 'error')) return null;
  return clone(parsed);
}

function mapIdentifiers(items, kind, diagnostics, report) {
  const used = new Set(), numericSourceIds = new Set(), bySource = new Map(), byKey = new Map();
  const valid = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!isRecord(item)) {
      diagnostics.push(diagnostic('INVALID_STRUCTURE', 'error', `/${kind}/${index}`, 'Legacy record must be an object.'));
      continue;
    }
    const sourceId = item.id;
    if (typeof sourceId === 'string' && ID.test(sourceId)) {
      if (used.has(sourceId)) {
        diagnostics.push(diagnostic('DUPLICATE_ID', 'error', `/${kind}/${index}/id`, 'Legacy identifier is duplicated.'));
        continue;
      }
      used.add(sourceId);
      bySource.set(sourceId, sourceId);
      valid.push({ item, index, id: sourceId, sourceId });
    } else if (typeof sourceId === 'number' && Number.isSafeInteger(sourceId)) {
      if (numericSourceIds.has(sourceId)) {
        diagnostics.push(diagnostic('DUPLICATE_ID', 'error', `/${kind}/${index}/id`, 'Legacy numeric identifier is duplicated.'));
        continue;
      }
      numericSourceIds.add(sourceId);
      valid.push({ item, index, id: null, sourceId });
    } else if (sourceId === undefined && kind === 'classes' &&
               (item.key === undefined || (typeof item.key === 'number' && Number.isSafeInteger(item.key)))) {
      valid.push({ item, index, id: null, sourceId: item.key === undefined ? index + 1 : item.key });
    } else {
      diagnostics.push(diagnostic('INVALID_LEGACY_ID', 'error', `/${kind}/${index}/id`, 'Legacy identifier is missing, invalid, or not safely representable.'));
    }
  }
  for (const entry of valid.filter(value => value.id === null)) {
    const numeric = entry.sourceId;
    const candidate = `legacy-${kind === 'classes' ? 'class' : kind === 'nodes' ? 'node' : 'edge'}-${numeric}`;
    entry.id = uniqueId(candidate, used);
    report.mappings.push({ kind: kind.slice(0, -1), sourceId: numeric, targetId: entry.id });
    if (kind !== 'classes') {
      const key = String(numeric);
      const prior = byKey.get(key);
      if (prior) {
        diagnostics.push(diagnostic('AMBIGUOUS_ID_MAPPING', 'error', `/${kind}/${entry.index}/id`, 'Numeric legacy identifier maps to more than one record.'));
      } else byKey.set(key, entry.id);
    }
  }
  for (const entry of valid.filter(value => value.id !== value.sourceId && typeof value.sourceId === 'string')) {
    bySource.set(entry.sourceId, entry.id);
  }
  if (kind === 'classes') {
    for (const entry of valid) {
      if (entry.item.key === undefined || (typeof entry.item.key === 'number' && Number.isSafeInteger(entry.item.key))) {
        const key = String(entry.item.key === undefined ? entry.index + 1 : entry.item.key);
        if (byKey.has(key) && byKey.get(key) !== entry.id) {
          diagnostics.push(diagnostic('AMBIGUOUS_ID_MAPPING', 'error', `/${kind}/${entry.index}/key`, 'Legacy class key maps to more than one record.'));
        } else byKey.set(key, entry.id);
      } else {
        diagnostics.push(diagnostic('INVALID_LEGACY_ID', 'error', `/classes/${entry.index}/key`, 'Legacy class key must be a safe integer when present.'));
      }
    }
  }
  return { valid, bySource, byKey };
}

function resolveReference(value, maps) {
  if (typeof value === 'string') return maps.bySource.get(value) || null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return maps.byKey.get(String(value)) || null;
  return null;
}

function migrationPreview(input) {
  const diagnostics = [];
  const report = {
    version: 1,
    counts: { classes: 0, entities: 0, relationships: 0, unresolvedRelationships: 0 },
    mappings: [],
    ambiguities: [],
    warnings: [],
  };
  const sourceBackup = inputAndBackup(input, diagnostics);
  const hasFormat = own(sourceBackup, 'format');
  const hasVersion = own(sourceBackup, 'version');
  if (!sourceBackup || !isRecord(sourceBackup) ||
      !Array.isArray(sourceBackup.classes) || !Array.isArray(sourceBackup.nodes) ||
      !Array.isArray(sourceBackup.edges)) {
    diagnostics.push(diagnostic('INVALID_STRUCTURE', 'error', '', 'Expected a bounded v1 board with optional format nodeboard and version 1, plus classes, nodes, and edges.'));
    return { ok: false, snapshot: null, sourceBackup, report, diagnostics: sortDiagnostics(diagnostics) };
  }
  if (hasFormat && sourceBackup.format !== 'nodeboard') {
    diagnostics.push(diagnostic('UNSUPPORTED_FORMAT', 'error', '/format', 'Only explicit nodeboard legacy exports are supported.'));
  }
  if (hasVersion && sourceBackup.version !== 1) {
    diagnostics.push(diagnostic('UNSUPPORTED_VERSION', 'error', '/version', 'Only explicit legacy version 1 exports are supported.'));
  }
  if (diagnostics.some(item => item.severity === 'error')) {
    return { ok: false, snapshot: null, sourceBackup, report, diagnostics: sortDiagnostics(diagnostics) };
  }

  const classMaps = mapIdentifiers(sourceBackup.classes, 'classes', diagnostics, report);
  const nodeMaps = mapIdentifiers(sourceBackup.nodes, 'nodes', diagnostics, report);
  const edgeMaps = mapIdentifiers(sourceBackup.edges, 'edges', diagnostics, report);
  const classes = [], classStyles = {};
  const classById = new Map(classMaps.valid.map(entry => [entry.id, entry]));
  const predicateDefinitions = new Map();
  const predicateCandidates = new Map();

  for (const entry of classMaps.valid) {
    const source = entry.item;
    if (typeof source.name !== 'string' || !source.name) {
      diagnostics.push(diagnostic('INVALID_LEGACY_CLASS', 'error', `/classes/${entry.index}/name`, 'Legacy classes require a non-empty name.'));
    }
    const extras = sourceFields(source, new Set(['id', 'key', 'name', 'shape', 'color', 'relations']));
    const metadata = { migration: { sourceIndex: entry.index } };
    if (own(source, 'id')) metadata.migration.sourceId = clone(source.id);
    if (own(source, 'key')) metadata.migration.legacyKey = clone(source.key);
    if (Object.keys(extras).length) metadata.migration.sourceFields = extras;
    classes.push({
      id: entry.id,
      name: source.name,
      superclassIds: [],
      abstract: false,
      propertyDefinitionIds: [],
      ...(Object.keys(metadata.migration).length > 1 ? { metadata } : {}),
    });
    if (typeof source.shape === 'string' || typeof source.color === 'string') {
      classStyles[entry.id] = {};
      if (typeof source.shape === 'string') classStyles[entry.id].shape = source.shape;
      if (typeof source.color === 'string') classStyles[entry.id].color = source.color;
    }
    if (!Array.isArray(source.relations)) {
      if (own(source, 'relations')) {
        diagnostics.push(diagnostic('INVALID_LEGACY_RELATIONS', 'error', `/classes/${entry.index}/relations`, 'Legacy class relations must be an array when present.'));
      }
      continue;
    }
    for (let relationIndex = 0; relationIndex < source.relations.length; relationIndex++) {
      const relation = source.relations[relationIndex];
      const path = `/classes/${entry.index}/relations/${relationIndex}`;
      if (!isRecord(relation) || typeof relation.label !== 'string' || !relation.label.trim()) {
        report.ambiguities.push({ path, reason: 'Predicate definition is unlabeled or malformed.' });
        diagnostics.push(diagnostic('UNRESOLVED_LEGACY_RELATIONSHIP', 'warning', path, 'Legacy predicate definition was retained but not mapped.'));
        continue;
      }
      const targetId = resolveReference(relation.to, classMaps);
      if (!targetId || !classById.has(targetId)) {
        report.ambiguities.push({ path, reason: 'Predicate target class could not be resolved.' });
        diagnostics.push(diagnostic('BROKEN_LEGACY_REFERENCE', 'error', `${path}/to`, 'Predicate target class could not be resolved.'));
        continue;
      }
      const signature = JSON.stringify([relation.label, entry.id, targetId]);
      const candidate = { label: relation.label, domain: entry.id, range: targetId, relation, path, signature };
      const list = predicateCandidates.get(relation.label) || [];
      list.push(candidate);
      predicateCandidates.set(relation.label, list);
      if (!predicateDefinitions.has(signature)) predicateDefinitions.set(signature, candidate);
    }
  }

  const relationshipTypes = [];
  const predicateBySignature = new Map();
  const predicateNames = new Set();
  for (const [signature, definition] of predicateDefinitions) {
    const candidate = definition;
    const digest = hash(signature);
    const id = boundedToken('rel-legacy-', slug(candidate.label), digest, new Set(relationshipTypes.map(item => item.id)));
    const predicate = boundedToken('LEGACY_', slug(candidate.label) + '_', digest, predicateNames);
    predicateBySignature.set(signature, id);
    relationshipTypes.push({
      id,
      predicate,
      label: candidate.label,
      domainClassIds: [candidate.domain],
      rangeClassIds: [candidate.range],
      inversePredicateId: null,
      symmetric: false,
      transitive: false,
      metadata: { migration: { sourcePath: candidate.path, legacyDefinition: clone(candidate.relation) } },
    });
  }

  const entities = [];
  const entityClassIds = new Map();
  for (const entry of nodeMaps.valid) {
    const source = entry.item;
    if (!Number.isFinite(source.x) || !Number.isFinite(source.y)) {
      diagnostics.push(diagnostic('INVALID_LEGACY_POSITION', 'error', `/nodes/${entry.index}`, 'Legacy nodes require finite numeric x and y coordinates.'));
    }
    if (typeof source.name !== 'string') {
      diagnostics.push(diagnostic('INVALID_LEGACY_NODE', 'error', `/nodes/${entry.index}/name`, 'Legacy nodes require a string name.'));
    }
    const classId = resolveReference(source.classId, classMaps);
    if (!classId) {
      diagnostics.push(diagnostic('BROKEN_LEGACY_REFERENCE', 'error', `/nodes/${entry.index}/classId`, 'Node class reference could not be resolved.'));
      continue;
    }
    entityClassIds.set(entry.id, classId);
    const extras = sourceFields(source, new Set(['id', 'x', 'y', 'name', 'classId', 'properties', 'status']));
    const metadata = { migration: { sourceId: source.id } };
    if (own(source, 'properties')) metadata.migration.legacyProperties = clone(source.properties);
    if (own(source, 'status')) metadata.migration.legacyStatus = clone(source.status);
    if (Object.keys(extras).length) metadata.migration.sourceFields = extras;
    entities.push({
      id: entry.id,
      classIds: [classId],
      name: typeof source.name === 'string' ? source.name : '',
      properties: {},
      externalIds: [],
      provenance: [],
      status: 'draft',
      ...(Object.keys(metadata.migration).length > 1 ? { metadata } : {}),
    });
    if (own(source, 'status')) report.warnings.push({
      path: `/nodes/${entry.index}/status`,
      message: 'Legacy status was retained as metadata without assigning a v2 lifecycle state.',
    });
    if (own(source, 'properties')) {
      const message = 'Legacy node properties were preserved as metadata without assigning unverified v2 semantics.';
      report.warnings.push({ path: `/nodes/${entry.index}/properties`, message });
      diagnostics.push(diagnostic('UNSUPPORTED_LEGACY_PROPERTIES', 'warning', `/nodes/${entry.index}/properties`, message));
    }
  }

  const relationships = [];
  for (const entry of edgeMaps.valid) {
    const source = entry.item;
    if (own(source, 'label') && typeof source.label !== 'string') {
      diagnostics.push(diagnostic('INVALID_LEGACY_LABEL', 'error', `/edges/${entry.index}/label`, 'Legacy edge labels must be strings when present.'));
    }
    const from = resolveReference(source.from, nodeMaps);
    const to = resolveReference(source.to, nodeMaps);
    if (!from || !to || !entityClassIds.has(from) || !entityClassIds.has(to)) {
      diagnostics.push(diagnostic('BROKEN_LEGACY_REFERENCE', 'error', `/edges/${entry.index}`, 'Edge endpoint could not be resolved to a migrated entity.'));
      continue;
    }
    const label = typeof source.label === 'string' ? source.label : '';
    const candidates = (predicateCandidates.get(label) || []).filter(candidate =>
      candidate.domain === entityClassIds.get(from) && candidate.range === entityClassIds.get(to));
    const signature = candidates.length === 1 ? candidates[0].signature : null;
    const metadata = { migration: { sourceId: source.id, legacyLabel: own(source, 'label') ? clone(source.label) : null } };
    const extras = sourceFields(source, new Set(['id', 'from', 'to', 'label', 'properties']));
    if (own(source, 'properties')) metadata.migration.legacyProperties = clone(source.properties);
    if (Object.keys(extras).length) metadata.migration.sourceFields = extras;
    const relationship = {
      id: entry.id,
      from,
      to,
      relationshipTypeId: signature ? predicateBySignature.get(signature) : null,
      ...(signature ? {} : { legacy: { label, reason: label ? (candidates.length ? 'ambiguous-predicate' : 'unresolved-predicate') : 'unlabeled' } }),
      properties: {},
      provenance: [],
      status: 'proposed',
      ...(Object.keys(metadata.migration).length > 1 ? { metadata } : {}),
    };
    if (!signature) {
      report.counts.unresolvedRelationships++;
      const reason = candidates.length ? 'Ambiguous predicate mapping retained as unresolved.' : 'No safe predicate definition matched the edge.';
      report.ambiguities.push({ path: `/edges/${entry.index}`, reason });
      diagnostics.push(diagnostic('UNRESOLVED_LEGACY_RELATIONSHIP', 'warning', `/edges/${entry.index}/label`, reason));
    }
    if (own(source, 'properties')) {
      const message = 'Legacy edge properties were preserved as metadata without assigning unverified v2 semantics.';
      report.warnings.push({ path: `/edges/${entry.index}/properties`, message });
      diagnostics.push(diagnostic('UNSUPPORTED_LEGACY_PROPERTIES', 'warning', `/edges/${entry.index}/properties`, message));
    }
    relationships.push(relationship);
  }

  const positions = {};
  for (const entry of nodeMaps.valid) {
    const source = entry.item;
    if (Number.isFinite(source.x) && Number.isFinite(source.y) && entityClassIds.has(entry.id)) {
      positions[entry.id] = { x: source.x, y: source.y };
    }
  }
  const sourceMetadata = { migration: {
    sourceVersion: 1,
    sourceBackup: clone(sourceBackup),
    report: clone(report),
  }};
  const snapshot = {
    format: 'nodeboard',
    version: 2,
    ontology: {
      id: 'legacy-v1',
      version: '1.0.0-migrated',
      classes,
      relationshipTypes,
      propertyDefinitions: [],
      constraints: [],
    },
    graph: { entities, relationships },
    views: [{
      id: 'view-legacy-default',
      name: 'Legacy default',
      scope: 'shared',
      query: {},
      entityIds: entities.map(entity => entity.id),
      positions,
      viewport: { x: 0, y: 0, zoom: 1 },
    }],
    presentation: { classStyles, relationshipStyles: {} },
    metadata: sourceMetadata,
  };
  report.counts.classes = classes.length;
  report.counts.entities = entities.length;
  report.counts.relationships = relationships.length;
  snapshot.metadata.migration.report = clone(report);
  const validation = validateSnapshot(snapshot);
  diagnostics.push(...validation);
  const errors = diagnostics.filter(item => item.severity === 'error');
  return {
    ok: errors.length === 0,
    snapshot: errors.length === 0 ? snapshot : null,
    sourceBackup,
    report,
    diagnostics: sortDiagnostics(diagnostics),
  };
}

export function previewV1Migration(input) {
  return { ...migrationPreview(input), sourceText: typeof input === 'string' ? input : null };
}

export function migrateV1ToV2(input) {
  return previewV1Migration(input);
}
