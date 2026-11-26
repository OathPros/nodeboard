import { openLocalV2Store } from './storage/local-v2.js';
import { createCloudV2Store, CloudStoreError } from './storage/cloud-v2.js';
import { openPendingCloudStore } from './storage/cloud-pending-v2.js';
import { prepareLocalV1Migration } from './application/local-migration-v2.js';
import { validateSnapshot } from './domain/validate-v2.js';
import { inspectConnections, inferTransitivePaths } from './domain/graph-v2.js';

const $ = id => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';
const clone = value => JSON.parse(JSON.stringify(value));
const id = () => crypto.randomUUID();
const propertyTypes = ['string', 'integer', 'decimal', 'boolean', 'date', 'datetime', 'uri', 'enum', 'list', 'structured'];
let store, activeStore, cloudStore = null, sharedStore = null, accountClient = null, accountUser = null;
let current = null, selectedId = null, migration = null, nextAfter = null, cloudNextAfter = null, busy = false;
let codeEmail = '', accountGeneration = 0, cloudListGeneration = 0;
let ontologyDraft = null, ontologyPreview = null;
let pendingStorePromise = null, pendingCloudChange = null, pendingCloudCopy = null;
let sharedLinkOpened = false;
let selectedViewId = null;

function status(message) { $('status').textContent = message; }
function errorText(error) {
  const detail = error?.message || 'The operation failed.';
  const message = error?.code === 'REVISION_CONFLICT' ? `${detail} Reload the board before editing.` : detail;
  const diagnostics = Array.isArray(error?.diagnostics) ? error.diagnostics : [];
  return [message, ...diagnostics.map(item => `${item.severity}: ${item.code} ${item.path || '/'}: ${item.message}`)].join('\n');
}
async function run(action) {
  if (busy) { status('An operation is already in progress.'); return; }
  busy = true;
  document.body.setAttribute('aria-busy', 'true');
  status('');
  try { await action(); }
  catch (error) {
    if (error?.code === 'NOT_FOUND' && current && activeStore !== store) {
      try { await showHome(); status('The account board is unavailable or access has ended.'); }
      catch (homeError) { status(errorText(homeError)); }
    } else status(errorText(error));
  }
  finally { busy = false; document.body.setAttribute('aria-busy', 'false'); }
}
function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
function growField(field) {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight + 2}px`;
}
function clearField(field) {
  field.value = '';
  growField(field);
}
async function readJsonFile(file, maxBytes, kind) {
  if (file.size > maxBytes) throw new Error(`The ${kind} file exceeds the local import limit.`);
  const contents = await file.text();
  try { return JSON.parse(contents); }
  catch { throw new Error(`The ${kind} file is not valid JSON.`); }
}
function downloadJson(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }));
  const link = element('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
function blankSnapshot(name) {
  return {
    format: 'nodeboard', version: 2,
    ontology: { id: id(), version: '1', classes: [], relationshipTypes: [], propertyDefinitions: [], constraints: [] },
    graph: { entities: [], relationships: [] },
    views: [{ id: id(), name: 'Default', scope: 'shared', query: {}, entityIds: [], positions: {}, viewport: { x: 0, y: 0, zoom: 1 } }],
    presentation: { classStyles: {}, relationshipStyles: {} },
    metadata: { name },
  };
}
function createEntityOperations(snapshot, entity) {
  const operations = [{ type: 'entity.put', entity }];
  const view = snapshot.views.find(item => item.id === selectedViewId) || snapshot.views[0];
  if (view) {
    const updated = clone(view);
    updated.entityIds.push(entity.id);
    const count = snapshot.graph.entities.length;
    updated.positions[entity.id] = { x: (count % 4) * 220, y: Math.floor(count / 4) * 120 };
    operations.push({ type: 'view.put', view: updated });
  }
  return operations;
}
function boardName(board) {
  const name = board.snapshot.metadata.name;
  return typeof name === 'string' && name.trim() ? name
    : board.snapshot.metadata.migration ? `Imported board (${board.id})` : board.id;
}
async function openBoard(boardId, source = store) {
  if (source !== store && !isAccountStore(source)) throw new Error('The account session changed. Sign in again.');
  const accountId = accountUser?.id || null;
  const board = await source.read(boardId);
  if (source !== store && !isAccountStore(source)) throw new Error('The account session changed. Sign in again.');
  if (!board) throw new Error('The board does not exist.');
  const key = source === store ? null : await pendingBoardKey(source, boardId);
  const pending = source === store ? null : await (await pendingStore()).get(accountId, key);
  const copy = source === store && accountId ? await (await pendingStore()).getCopy(accountId, boardId) : null;
  if (source !== store && !isAccountStore(source)) throw new Error('The account session changed. Sign in again.');
  activeStore = source;
  current = board;
  selectedViewId = null;
  pendingCloudChange = pending;
  pendingCloudCopy = accountUser?.id === accountId ? copy : null;
  $('sharing-panel').hidden = true;
  selectedId = null;
  clearField($('entity-search'));
  resetOntologyEditor();
  $('home').hidden = true;
  $('editor').hidden = false;
  render();
  if (pending) status('An account change is waiting to be retried.');
  else if (pendingCloudCopy) status('An account copy is waiting to be retried.');
}
async function loadBoards(after) {
  const page = await store.list(after ? { after } : {});
  if (!after) $('boards').replaceChildren();
  for (const boardId of page.ids) {
    const item = element('li');
    try {
      const board = await store.read(boardId);
      if (!board) continue;
      const button = element('button', boardName(board));
      button.type = 'button';
      button.addEventListener('click', () => run(() => openBoard(boardId)));
      item.append(button);
    } catch (error) {
      item.textContent = `${boardId}: ${errorText(error)}`;
    }
    $('boards').append(item);
  }
  nextAfter = page.nextAfter;
  $('more-boards').hidden = !nextAfter;
}
async function loadCloudBoards(after) {
  const source = cloudStore;
  if (!source) return;
  const generation = ++cloudListGeneration;
  const page = await source.list(after ? { after } : {});
  if (source !== cloudStore || generation !== cloudListGeneration) return;
  if (!after) $('cloud-boards').replaceChildren();
  for (const boardId of page.ids) {
    const item = element('li');
    try {
      const board = await source.read(boardId);
      if (source !== cloudStore || generation !== cloudListGeneration) return;
      if (!board) continue;
      const button = element('button', boardName(board));
      button.type = 'button';
      button.addEventListener('click', () => run(() => openBoard(boardId, source)));
      item.append(button);
    } catch (error) {
      if (source !== cloudStore || generation !== cloudListGeneration) return;
      item.textContent = `${boardId}: ${errorText(error)}`;
    }
    $('cloud-boards').append(item);
  }
  cloudNextAfter = page.nextAfter;
  $('more-cloud-boards').hidden = !cloudNextAfter;
}
async function loadMembers(source, boardId) {
  const result = await source.members(boardId);
  if (activeStore !== source || current?.id !== boardId || source !== cloudStore) {
    throw new Error('The board or account changed while loading sharing.');
  }
  const entries = result.members.map(member => {
    const item = element('li', `${member.email} (${member.role}) `);
    const button = element('button', 'Remove access');
    button.type = 'button';
    button.setAttribute('aria-label', `Remove access for ${member.email}`);
    button.addEventListener('click', () => run(async () => {
      if (!window.confirm(`Remove access for ${member.email}?`)) return;
      await source.unshare(boardId, member.userId);
      await loadMembers(source, boardId);
      status('Access removed.');
    }));
    item.append(button);
    return item;
  });
  $('sharing-members').replaceChildren(...entries);
}
function updateCopyButtons() {
  $('copy-to-account').hidden = !current || !cloudStore || activeStore !== store;
  $('copy-to-local').hidden = !current || activeStore === store;
  $('retry-cloud-copy').hidden = !current || activeStore !== store || !cloudStore || !pendingCloudCopy;
  $('open-sharing').hidden = !current || activeStore !== cloudStore || current.role !== 'owner';
}
function isAccountStore(source) { return !!source && (source === cloudStore || source === sharedStore); }
async function pendingBoardKey(source, boardId) {
  if (!source.ownerId) return boardId;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${source.ownerId}\0${boardId}`));
  return `shared_${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
async function accountToken(userId) {
  const latest = await accountClient.auth.getSession();
  if (latest.error) throw latest.error;
  if (!latest.data.session || latest.data.session.user?.id !== userId) {
    throw new Error('The account session changed. Sign in again.');
  }
  return latest.data.session.access_token;
}
async function openSharedLink() {
  if (sharedLinkOpened || !accountUser) return;
  const query = new URL(location.href).searchParams;
  const ownerId = query.get('sharedOwner'), boardId = query.get('sharedBoard');
  if (!ownerId && !boardId) return;
  const idPattern = /^[A-Za-z0-9_-]{1,120}$(?![\s\S])/;
  if (!ownerId || !boardId || !idPattern.test(ownerId) || !idPattern.test(boardId)) {
    throw new Error('The shared board link is invalid.');
  }
  const userId = accountUser.id;
  const source = createCloudV2Store(() => accountToken(userId), ownerId);
  sharedStore = source;
  sharedLinkOpened = true;
  try { await openBoard(boardId, source); }
  catch (error) { sharedLinkOpened = false; if (sharedStore === source) sharedStore = null; throw error; }
}
async function updateAccount() {
  const generation = ++accountGeneration;
  const sessionResult = await accountClient.auth.getSession();
  if (sessionResult.error) throw sessionResult.error;
  const session = sessionResult.data.session;
  let user = null;
  if (session) {
    const response = await fetch('/api/account', { headers: { authorization: `Bearer ${session.access_token}` } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to verify the account.');
    user = data.user;
    if (!session.user || session.user.id !== user.id) throw new Error('The account session does not match the verified user.');
  }
  if (generation !== accountGeneration) return;
  const changed = accountUser?.id !== user?.id;
  if (changed) {
    const wasCloudBoard = current && activeStore !== store;
    accountUser = user;
    sharedStore = null;
    sharedLinkOpened = false;
    cloudStore = user ? createCloudV2Store(() => accountToken(user.id)) : null;
    $('cloud-boards').replaceChildren();
    $('more-cloud-boards').hidden = true;
    pendingCloudCopy = null;
    if (wasCloudBoard) {
      await showHome();
      status('The account changed. The account board was closed.');
    }
  }
  $('account-sign-in').hidden = !!user;
  $('account-signed-in').hidden = !user;
  $('account-identity').textContent = user ? user.email : '';
  if (user && current && activeStore === store) {
    const boardId = current.id;
    const copy = await (await pendingStore()).getCopy(user.id, boardId);
    if (generation !== accountGeneration) return;
    if (current?.id === boardId && activeStore === store && accountUser?.id === user.id) pendingCloudCopy = copy;
  }
  updateCopyButtons();
  if (user && !$('home').hidden) await loadCloudBoards();
  if (user && !$('home').hidden) await openSharedLink();
}
async function initializeAccounts() {
  if (!['http:', 'https:'].includes(location.protocol)) return;
  const response = await fetch('/api/account/config');
  if (!response.ok) throw new Error('The account configuration could not be loaded.');
  const config = await response.json();
  if (!config.enabled) return;
  if (typeof window.createNodeboardAuth !== 'function') throw new Error('The account client could not be loaded.');
  accountClient = window.createNodeboardAuth(config.url, config.key);
  $('account-area').hidden = false;
  accountClient.auth.onAuthStateChange(() => {
    setTimeout(() => { updateAccount().catch(error => status(errorText(error))); }, 0);
  });
  await updateAccount();
}
async function showHome() {
  current = null;
  selectedViewId = null;
  activeStore = store;
  pendingCloudChange = null;
  pendingCloudCopy = null;
  $('sharing-panel').hidden = true;
  selectedId = null;
  resetOntologyEditor();
  $('home').hidden = false;
  $('editor').hidden = true;
  $('undo-button').disabled = true;
  $('redo-button').disabled = true;
  $('backup-button').disabled = true;
  $('export-native').disabled = true;
  await loadBoards();
  if (cloudStore) await loadCloudBoards();
}
function pendingStore() {
  if (!pendingStorePromise) {
    pendingStorePromise = openPendingCloudStore().catch(error => {
      pendingStorePromise = null;
      throw error;
    });
  }
  return pendingStorePromise;
}
function setPendingChange(source, boardId, record) {
  if (current?.id !== boardId || activeStore !== source || !isAccountStore(source)) return;
  pendingCloudChange = record;
  for (const button of ['retry-cloud-change', 'export-cloud-change', 'discard-cloud-change']) {
    $(button).hidden = !record;
  }
}
function checkPendingContext(source, boardId, accountId) {
  if (!current || current.id !== boardId || activeStore !== source ||
      !isAccountStore(source) || accountUser?.id !== accountId) {
    throw new Error('The account or board changed. Reopen the board before continuing.');
  }
}
async function currentPendingChange() {
  if (!current || !accountUser || !isAccountStore(activeStore)) throw new Error('Open the account board first.');
  const source = activeStore, boardId = current.id, accountId = accountUser.id;
  const pending = await pendingStore();
  const key = await pendingBoardKey(source, boardId);
  const record = await pending.get(accountId, key);
  checkPendingContext(source, boardId, accountId);
  if (record && (record.targetBoardId || record.boardId) !== boardId) {
    throw new Error('The pending change does not match this board.');
  }
  if (!record) setPendingChange(source, boardId, null);
  return { source, boardId, accountId, key, pending, record };
}
function setPendingCopy(destination, boardId, record) {
  if (current?.id !== boardId || activeStore !== store || destination !== cloudStore) return;
  pendingCloudCopy = record;
  updateCopyButtons();
}
async function sendPendingCopy(destination, record) {
  const pending = await pendingStore();
  let result;
  try { result = await destination.create(record.payload.id, record.payload.snapshot); }
  catch (error) {
    if (error instanceof CloudStoreError && [400, 409, 413, 426].includes(error.status)) {
      try {
        await pending.removeCopy(record.accountId, record.boardId, record.payload.id);
        setPendingCopy(destination, record.boardId, await pending.getCopy(record.accountId, record.boardId));
      } catch (cleanupError) {
        throw new Error(`${errorText(error)} Pending-copy cleanup failed: ${errorText(cleanupError)}`);
      }
    }
    throw error;
  }
  await pending.removeCopy(record.accountId, record.boardId, record.payload.id);
  setPendingCopy(destination, record.boardId, await pending.getCopy(record.accountId, record.boardId));
  return result;
}
async function sendPendingChange(source, record) {
  const pending = await pendingStore();
  const targetBoardId = record.targetBoardId || record.boardId;
  let result;
  try {
    result = record.kind === 'operations'
      ? await source.apply(targetBoardId, record.payload)
      : await source.history(targetBoardId, record.payload);
  } catch (error) {
    if (error instanceof CloudStoreError && [400, 409, 413, 426].includes(error.status)) {
      try {
        await pending.remove(record.accountId, record.boardId, record.payload.operationId);
        setPendingChange(source, targetBoardId, await pending.get(record.accountId, record.boardId));
      } catch (cleanupError) {
        throw new Error(`${errorText(error)} Pending-change cleanup failed: ${errorText(cleanupError)}`);
      }
    }
    throw error;
  }
  await pending.remove(record.accountId, record.boardId, record.payload.operationId);
  setPendingChange(source, targetBoardId, await pending.get(record.accountId, record.boardId));
  return result;
}
async function submitCloudChange(source, boardId, kind, payload) {
  if (!accountUser || !isAccountStore(source)) throw new Error('The account session changed. Sign in again.');
  const accountId = accountUser.id;
  const pending = await pendingStore();
  const key = await pendingBoardKey(source, boardId);
  if (!accountUser || accountUser.id !== accountId || !isAccountStore(source)) throw new Error('The account session changed. Sign in again.');
  const record = { accountId, boardId: key, targetBoardId: boardId, kind, payload };
  try { await pending.add(record); }
  catch (error) {
    setPendingChange(source, boardId, await pending.get(record.accountId, key));
    throw error;
  }
  setPendingChange(source, boardId, record);
  return sendPendingChange(source, record);
}
async function apply(operations) {
  const source = activeStore, boardId = current.id;
  const batch = {
    protocolVersion: 2, snapshotVersion: 2, operationId: id(), baseRevision: current.revision, operations,
  };
  const result = source === store ? await source.apply(boardId, batch)
    : await submitCloudChange(source, boardId, 'operations', batch);
  if (!current || current.id !== boardId || activeStore !== source || (source !== store && !isAccountStore(source))) {
    throw new Error('The board changed while the operation was pending. Reopen it to check whether the operation was saved.');
  }
  current = result;
  if (result.historyTruncated || result.retryHistoryTruncated) status('Older local history was removed to stay within storage limits.');
  render();
}
function selectOptions(select, items, label) {
  const previous = select.dataset.value;
  const chosen = items.find(item => item.id === previous) || items[0];
  select.dataset.value = chosen?.id || '';
  select.className = 'choice';
  select.open = false;
  const summary = element('summary', chosen?.name || label);
  summary.setAttribute('aria-label', `${select.dataset.label}: ${chosen?.name || label}`);
  summary.addEventListener('click', event => { if (!items.length) event.preventDefault(); });
  const choices = element('div');
  choices.className = 'choice-options';
  for (const item of items) {
    const button = element('button', item.name);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(item.id === chosen?.id));
    button.addEventListener('click', () => {
      select.dataset.value = item.id;
      summary.textContent = item.name;
      summary.setAttribute('aria-label', `${select.dataset.label}: ${item.name}`);
      for (const child of choices.children) child.setAttribute('aria-pressed', String(child === button));
      select.open = false;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      summary.focus();
    });
    choices.append(button);
  }
  select.replaceChildren(summary, choices);
}
function ontologyItem(item, collection, property, kind) {
  const entry = element('li');
  entry.dataset.ontologyId = item.id;
  const details = element('details');
  const summary = element('summary', item[property]);
  const form = element('form');
  const label = element('label', `${kind} name`);
  const field = element('textarea');
  field.rows = 1;
  field.required = true;
  field.value = item[property];
  label.append(field);
  form.append(label, element('button', `Save ${kind.toLowerCase()} name`));
  form.addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      const name = field.value.trim();
      if (!name) throw new Error(`Enter a ${kind.toLowerCase()} name.`);
      const ontology = clone(current.snapshot.ontology);
      const target = ontology[collection].find(value => value.id === item.id);
      if (!target) throw new Error(`${kind} no longer exists; reload the board.`);
      target[property] = name;
      await apply([{ type: 'ontology.replace', ontology }]);
      if (!$('status').textContent) status(`${kind} name saved.`);
      const list = collection === 'classes' ? $('classes') : $('predicates');
      [...list.children].find(value => value.dataset.ontologyId === item.id)?.querySelector('summary')?.focus();
    });
  });
  details.addEventListener('toggle', () => { if (details.open) growField(field); });
  details.append(summary, form);
  entry.append(details);
  if (collection === 'classes') entry.append(classDefinitionEditor(item));
  if (collection === 'relationshipTypes') entry.append(predicateDefinitionEditor(item));
  return entry;
}
function selectedIdsInExistingOrder(existing, choices) {
  const selected = choices.filter(choice => choice.checkbox.checked).map(choice => choice.id);
  return [...existing.filter(value => selected.includes(value)), ...selected.filter(value => !existing.includes(value))];
}
function classDefinitionEditor(item) {
  const details = element('details');
  details.dataset.classDefinitionEditor = '';
  details.append(element('summary', 'Class hierarchy'));
  details.addEventListener('toggle', () => {
    if (!details.open || details.querySelector('form')) return;
    const form = element('form');
    const abstractLabel = element('label');
    const abstract = element('input');
    abstract.type = 'checkbox';
    abstract.checked = item.abstract;
    abstractLabel.append(abstract, ' Abstract class');
    const parents = element('fieldset');
    parents.append(element('legend', 'Parent classes'));
    const choices = [];
    for (const candidate of current.snapshot.ontology.classes) {
      if (candidate.id === item.id) continue;
      const label = element('label');
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.superclassIds.includes(candidate.id);
      label.append(checkbox, ` ${candidate.name} (${candidate.id})`);
      parents.append(label);
      choices.push({ id: candidate.id, checkbox });
    }
    if (!choices.length) parents.append(element('p', 'No other classes.'));
    const properties = element('fieldset');
    properties.append(element('legend', 'Class properties'));
    const propertyChoices = [];
    for (const definition of current.snapshot.ontology.propertyDefinitions) {
      const label = element('label');
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.propertyDefinitionIds.includes(definition.id);
      label.append(checkbox, ` ${definition.name} (${definition.id})`);
      properties.append(label);
      propertyChoices.push({ id: definition.id, checkbox });
    }
    if (!propertyChoices.length) properties.append(element('p', 'No properties.'));
    form.append(abstractLabel, parents, properties, element('button', 'Save class hierarchy'));
    form.addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const ontology = clone(current.snapshot.ontology);
        const target = ontology.classes.find(candidate => candidate.id === item.id);
        if (!target) throw new Error('Class no longer exists; reload the board.');
        target.abstract = abstract.checked;
        target.superclassIds = selectedIdsInExistingOrder(target.superclassIds, choices);
        target.propertyDefinitionIds = selectedIdsInExistingOrder(target.propertyDefinitionIds, propertyChoices);
        await apply([{ type: 'ontology.replace', ontology }]);
        if (!$('status').textContent) status('Class hierarchy saved.');
        [...$('classes').children].find(value => value.dataset.ontologyId === item.id)
          ?.querySelector('[data-class-definition-editor] > summary')?.focus();
      });
    });
    details.append(form);
  });
  return details;
}
function predicateDefinitionEditor(item) {
  const details = element('details');
  details.dataset.predicateDefinitionEditor = '';
  details.append(element('summary', 'Predicate definition'));
  details.addEventListener('toggle', () => {
    if (!details.open || details.querySelector('form')) return;
    const form = element('form');
    const inverse = element('details');
    inverse.dataset.label = 'Inverse predicate';
    inverse.dataset.value = item.inversePredicateId || '';
    const predicateOptions = current.snapshot.ontology.relationshipTypes.map(value => ({
      id: value.id, name: `${value.label} (${value.id})`,
    }));
    selectOptions(inverse, [{ id: '', name: 'No inverse' }, ...predicateOptions], 'No inverse');
    form.append(element('span', 'Inverse predicate'), inverse);
    const flags = {};
    for (const [key, name] of [['symmetric', 'Symmetric'], ['transitive', 'Transitive']]) {
      const label = element('label');
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item[key];
      label.append(checkbox, ` ${name}`);
      flags[key] = checkbox;
      form.append(label);
    }
    const selections = {};
    for (const [key, name] of [['domainClassIds', 'Source classes'], ['rangeClassIds', 'Target classes']]) {
      const fieldset = element('fieldset');
      fieldset.append(element('legend', name));
      selections[key] = [];
      for (const candidate of current.snapshot.ontology.classes) {
        const label = element('label');
        const checkbox = element('input');
        checkbox.type = 'checkbox';
        checkbox.checked = item[key].includes(candidate.id);
        label.append(checkbox, ` ${candidate.name} (${candidate.id})`);
        fieldset.append(label);
        selections[key].push({ id: candidate.id, checkbox });
      }
      if (!selections[key].length) fieldset.append(element('p', 'No classes.'));
      form.append(fieldset);
    }
    form.append(element('button', 'Save predicate definition'));
    form.addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const ontology = clone(current.snapshot.ontology);
        const target = ontology.relationshipTypes.find(candidate => candidate.id === item.id);
        if (!target) throw new Error('Predicate no longer exists; reload the board.');
        target.inversePredicateId = inverse.dataset.value || null;
        target.symmetric = flags.symmetric.checked;
        target.transitive = flags.transitive.checked;
        target.domainClassIds = selectedIdsInExistingOrder(target.domainClassIds, selections.domainClassIds);
        target.rangeClassIds = selectedIdsInExistingOrder(target.rangeClassIds, selections.rangeClassIds);
        await apply([{ type: 'ontology.replace', ontology }]);
        if (!$('status').textContent) status('Predicate definition saved.');
        [...$('predicates').children].find(value => value.dataset.ontologyId === item.id)
          ?.querySelector('[data-predicate-definition-editor] > summary')?.focus();
      });
    });
    details.append(form);
  });
  return details;
}
function clearOntologyPreview() {
  ontologyPreview = null;
  $('ontology-apply').disabled = true;
  $('ontology-report').replaceChildren();
}
function resetOntologyEditor() {
  ontologyDraft = null;
  $('ontology-editor').open = false;
  $('ontology-json').value = '';
  clearOntologyPreview();
}
function loadOntologyDraft() {
  const text = JSON.stringify(current.snapshot.ontology, null, 2);
  $('ontology-json').value = text;
  ontologyDraft = { text, revision: current.revision, boardId: current.id };
  clearOntologyPreview();
  growField($('ontology-json'));
}
function ontologyChanges(before, after) {
  const changes = [];
  for (const [collection, label] of [
    ['classes', 'Class'], ['relationshipTypes', 'Predicate'],
    ['propertyDefinitions', 'Property'], ['constraints', 'Constraint'],
  ]) {
    const oldItems = new Map(before[collection].map(item => [item.id, item]));
    const newItems = new Map(after[collection].map(item => [item.id, item]));
    for (const [key, item] of oldItems) {
      if (!newItems.has(key)) changes.push(`Removed ${label}: ${key}`);
      else if (JSON.stringify(item) !== JSON.stringify(newItems.get(key))) changes.push(`Changed ${label}: ${key}`);
    }
    for (const key of newItems.keys()) if (!oldItems.has(key)) changes.push(`Added ${label}: ${key}`);
  }
  for (const key of ['id', 'version', 'metadata']) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes.push(`Changed ontology ${key}`);
  }
  return changes;
}
function relationshipEditor(relationship, entities, predicates) {
  const details = element('details');
  details.dataset.relationshipEditor = '';
  details.append(element('summary', 'Edit relationship'));
  details.addEventListener('toggle', () => {
    if (!details.open || details.querySelector('form')) return;
    const form = element('form');
    const fields = [
      { key: 'from', label: 'Relationship source', value: relationship.from, items: entities },
      { key: 'relationshipTypeId', label: 'Relationship predicate', value: relationship.relationshipTypeId || '',
        items: relationship.relationshipTypeId === null
          ? [{ id: '', name: `Unresolved: ${relationship.legacy.label || '(unlabeled)'}` }, ...predicates] : predicates },
      { key: 'to', label: 'Relationship target', value: relationship.to, items: entities },
    ];
    const controls = {};
    for (const field of fields) {
      const choice = element('details');
      choice.dataset.label = field.label;
      choice.dataset.value = field.value;
      selectOptions(choice, field.items, `Choose ${field.label.toLowerCase()}`);
      controls[field.key] = choice;
      form.append(element('span', field.label), choice);
    }
    form.append(element('button', 'Save relationship'));
    form.addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const updated = {
          ...relationship,
          from: controls.from.dataset.value,
          relationshipTypeId: controls.relationshipTypeId.dataset.value || null,
          to: controls.to.dataset.value,
        };
        await apply([{ type: 'relationship.put', relationship: updated }]);
        if (!$('status').textContent) status('Relationship saved.');
        [...$('relationships').children].find(item => item.dataset.relationshipId === relationship.id)
          ?.querySelector('[data-relationship-editor] > summary')?.focus();
      });
    });
    details.append(form);
  });
  return details;
}
function propertyEditor(record, kind) {
  const details = element('details');
  details.dataset.propertyEditor = '';
  details.append(element('summary', `${kind} properties`));
  details.addEventListener('toggle', () => {
    if (!details.open) return;
    if (details.dataset.loaded) {
      for (const field of details.querySelectorAll('textarea')) growField(field);
      return;
    }
    details.dataset.loaded = 'true';
    const definitions = current.snapshot.ontology.propertyDefinitions;
    if (definitions.length) {
      details.append(element('p', 'Edit individual properties'));
      for (const definition of definitions) details.append(singlePropertyEditor(record, kind, definition));
    }
    const form = element('form');
    const label = element('label', `${kind} properties JSON`);
    const field = element('textarea');
    field.rows = 3;
    field.spellcheck = false;
    field.value = JSON.stringify(record.properties, null, 2);
    label.append(field);
    form.append(label, element('button', `Save ${kind.toLowerCase()} properties`));
    form.addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        let properties;
        try { properties = JSON.parse(field.value); }
        catch { throw new Error('Properties must be valid JSON.'); }
        if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
          throw new Error('Properties must be a JSON object keyed by property definition ID.');
        }
        await savePropertyMap(record, kind, properties);
      });
    });
    details.append(form);
    growField(field);
  });
  return details;
}
async function savePropertyMap(record, kind, properties) {
  const type = kind.toLowerCase();
  await apply([{ type: `${type}.put`, [type]: { ...record, properties } }]);
  if (!$('status').textContent) status(`${kind} properties saved.`);
  const owner = type === 'entity' ? $('inspector')
    : [...$('relationships').children].find(item => item.dataset.relationshipId === record.id);
  owner?.querySelector('[data-property-editor] > summary')?.focus();
}
function singlePropertyEditor(record, kind, definition) {
  const details = element('details');
  const type = definition.dataType === 'list' ? `list of ${definition.listItemType}` : definition.dataType;
  details.append(element('summary', `${definition.name} (${definition.id}; ${type})`));
  details.addEventListener('toggle', () => {
    if (!details.open) return;
    if (details.querySelector('form')) {
      for (const field of details.querySelectorAll('textarea')) growField(field);
      return;
    }
    const form = element('form');
    const exists = Object.hasOwn(record.properties, definition.id);
    const currentValue = record.properties[definition.id];
    let readValue;
    if (definition.dataType === 'enum') {
      const choice = element('details');
      choice.dataset.label = `${definition.name} value`;
      const index = exists ? definition.enumValues.indexOf(currentValue) : 0;
      choice.dataset.value = String(index);
      selectOptions(choice, definition.enumValues.map((value, i) => ({ id: String(i), name: JSON.stringify(value) })), 'Choose a value');
      form.append(element('span', `${definition.name} value`), choice);
      readValue = () => definition.enumValues[Number(choice.dataset.value)];
    } else if (definition.dataType === 'boolean') {
      const label = element('label');
      const input = element('input');
      input.type = 'checkbox';
      input.checked = exists ? currentValue : false;
      label.append(input, ` ${definition.name} value`);
      form.append(label);
      readValue = () => input.checked;
    } else {
      const label = element('label', `${definition.name} value`);
      const field = element('textarea');
      field.rows = 1;
      const jsonValue = ['integer', 'decimal', 'list', 'structured'].includes(definition.dataType);
      field.value = exists ? (jsonValue ? JSON.stringify(currentValue, null, 2) : currentValue) : '';
      label.append(field);
      form.append(label);
      readValue = () => {
        if (!jsonValue) return field.value;
        try { return JSON.parse(field.value); }
        catch { throw new Error(`${definition.name} must be a valid JSON ${definition.dataType} value.`); }
      };
      requestAnimationFrame(() => { if (details.open && field.isConnected) growField(field); });
    }
    const save = element('button', `Save ${definition.name} value`);
    const remove = element('button', `Remove ${definition.name} value`);
    remove.type = 'button';
    remove.disabled = !exists;
    remove.addEventListener('click', () => run(async () => {
      const properties = { ...record.properties };
      delete properties[definition.id];
      await savePropertyMap(record, kind, properties);
    }));
    form.append(save, remove);
    form.addEventListener('submit', event => {
      event.preventDefault();
      run(() => savePropertyMap(record, kind, { ...record.properties, [definition.id]: readValue() }));
    });
    details.append(form);
  });
  return details;
}
function classEditor(entity, classes) {
  const details = element('details');
  details.append(element('summary', 'Entity classes'));
  const form = element('form');
  const selections = [];
  for (const item of classes) {
    const label = element('label');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.checked = entity.classIds.includes(item.id);
    checkbox.disabled = item.abstract;
    label.append(checkbox, document.createTextNode(` ${item.name}${item.abstract ? ' (abstract)' : ''}`));
    form.append(label);
    selections.push({ id: item.id, checkbox });
  }
  form.append(element('button', 'Save entity classes'));
  form.addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      const selected = new Set(selections.filter(value => value.checkbox.checked).map(value => value.id));
      const classIds = entity.classIds.filter(value => selected.has(value));
      for (const { id } of selections) if (selected.has(id) && !classIds.includes(id)) classIds.push(id);
      await apply([{ type: 'entity.put', entity: { ...entity, classIds } }]);
      if (!$('status').textContent) status('Entity classes saved.');
      $('inspector').querySelector('[data-class-editor] summary')?.focus();
    });
  });
  details.dataset.classEditor = '';
  details.append(form);
  return details;
}
function provenanceEditor(record, kind) {
  const details = element('details');
  details.dataset.provenanceEditor = '';
  details.append(element('summary', `${kind} status and provenance`));
  const form = element('form');
  const fieldset = element('fieldset');
  fieldset.append(element('legend', `${kind} status`));
  const statuses = kind === 'Entity' ? ['active', 'draft', 'retired'] : ['asserted', 'proposed', 'disputed', 'superseded'];
  const choices = [];
  for (const value of statuses) {
    const label = element('label');
    const radio = element('input');
    radio.type = 'radio';
    radio.name = `${kind}-${record.id}-status`;
    radio.value = value;
    radio.checked = value === record.status;
    label.append(radio, document.createTextNode(` ${value}`));
    fieldset.append(label);
    choices.push(radio);
  }
  const label = element('label', `${kind} provenance JSON`);
  const field = element('textarea');
  field.rows = 3;
  field.spellcheck = false;
  field.value = JSON.stringify(record.provenance, null, 2);
  label.append(field);
  form.append(fieldset, label, element('button', `Save ${kind.toLowerCase()} status and provenance`));
  details.addEventListener('toggle', () => { if (details.open) growField(field); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      let provenance;
      try { provenance = JSON.parse(field.value); }
      catch { throw new Error('Provenance must be valid JSON.'); }
      if (!Array.isArray(provenance)) throw new Error('Provenance must be a JSON array.');
      const selected = choices.find(choice => choice.checked);
      if (!selected) throw new Error(`Choose a ${kind.toLowerCase()} status.`);
      const type = kind.toLowerCase();
      await apply([{ type: `${type}.put`, [type]: { ...record, status: selected.value, provenance } }]);
      if (!$('status').textContent) status(`${kind} status and provenance saved.`);
      const owner = type === 'entity' ? $('inspector')
        : [...$('relationships').children].find(item => item.dataset.relationshipId === record.id);
      owner?.querySelector('[data-provenance-editor] > summary')?.focus();
    });
  });
  details.append(form);
  return details;
}
function render() {
  const snapshot = current.snapshot;
  const readOnly = current.role === 'viewer';
  const selectedView = snapshot.views.find(view => view.id === selectedViewId);
  if (!selectedView) selectedViewId = null;
  else if (selectedId && !selectedView.entityIds.includes(selectedId)) selectedId = null;
  $('view-choice').dataset.value = selectedViewId || '@all';
  selectOptions($('view-choice'), [
    { id: '@all', name: 'All entities' },
    ...snapshot.views.map(view => ({ id: view.id, name: `${view.name} (${view.id}; ${view.scope})` })),
  ], 'All entities');
  $('create-view-form').hidden = readOnly;
  renderViewManagement(snapshot, selectedView, readOnly);
  $('board-title').textContent = boardName(current);
  $('board-revision').textContent = `Revision ${current.revision}`;
  $('undo-button').disabled = !current.history.undo;
  $('redo-button').disabled = !current.history.redo;
  $('backup-button').disabled = false;
  $('export-native').disabled = false;
  updateCopyButtons();
  for (const button of ['retry-cloud-change', 'export-cloud-change', 'discard-cloud-change']) {
    $(button).hidden = !pendingCloudChange || activeStore === store;
  }
  if (ontologyPreview && (ontologyPreview.boardId !== current.id || ontologyPreview.revision !== current.revision)) clearOntologyPreview();
  $('classes').replaceChildren(...snapshot.ontology.classes.map(item => readOnly ? element('li', item.name) : ontologyItem(item, 'classes', 'name', 'Class')));
  $('predicates').replaceChildren(...snapshot.ontology.relationshipTypes.map(item => readOnly ? element('li', item.label) : ontologyItem(item, 'relationshipTypes', 'label', 'Predicate')));
  $('properties').replaceChildren(...snapshot.ontology.propertyDefinitions.map(item => {
    const entry = element('li', `${item.name} (${item.id}; ${item.dataType === 'list' ? `list of ${item.listItemType}` : item.dataType})`);
    entry.dataset.propertyId = item.id;
    return entry;
  }));
  for (const id of ['add-class-form', 'add-predicate-form', 'add-property-form', 'add-required-form',
    'add-entity-form', 'add-relationship-form', 'ontology-editor']) $(id).hidden = readOnly;
  const classes = snapshot.ontology.classes.filter(item => !item.abstract);
  const entities = snapshot.graph.entities.map(item => ({ id: item.id, name: item.name || item.id }));
  const predicates = snapshot.ontology.relationshipTypes.map(item => ({ id: item.id, name: item.label }));
  selectOptions($('required-class'), snapshot.ontology.classes.map(item => ({ id: item.id, name: `${item.name} (${item.id})` })), 'Add a class first');
  selectOptions($('required-property'), snapshot.ontology.propertyDefinitions.map(item => ({ id: item.id, name: `${item.name} (${item.id})` })), 'Add a property first');
  $('add-required-form').querySelector('button[type="submit"]').disabled = !snapshot.ontology.classes.length || !snapshot.ontology.propertyDefinitions.length;
  const constraintClasses = new Map(snapshot.ontology.classes.map(item => [item.id, item.name]));
  const constraintProperties = new Map(snapshot.ontology.propertyDefinitions.map(item => [item.id, item.name]));
  $('constraints').replaceChildren(...snapshot.ontology.constraints.map(constraint => {
    const text = constraint.kind === 'required'
      ? `${constraintClasses.get(constraint.parameters.classId)} requires ${constraintProperties.get(constraint.parameters.propertyId)} (${constraint.id})`
      : `${constraint.kind} (${constraint.id})`;
    const entry = element('li', text);
    entry.dataset.constraintId = constraint.id;
    if (!readOnly) {
      const remove = element('button', 'Remove constraint');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove constraint ${constraint.id}`);
      remove.addEventListener('click', () => run(async () => {
        if (!window.confirm('Remove this constraint?')) return;
        const ontology = clone(current.snapshot.ontology);
        ontology.constraints = ontology.constraints.filter(item => item.id !== constraint.id);
        await apply([{ type: 'ontology.replace', ontology }]);
        if (!$('status').textContent) status('Constraint removed.');
      }));
      entry.append(' ', remove);
    }
    return entry;
  }));
  selectOptions($('entity-class'), classes, 'Add a class first');
  selectOptions($('relationship-from'), entities, 'Add an entity first');
  selectOptions($('relationship-to'), entities, 'Add an entity first');
  selectOptions($('relationship-type'), predicates, 'Add a predicate first');
  $('add-entity-form').querySelector('button[type="submit"]').disabled = !classes.length;
  $('add-relationship-form').querySelector('button[type="submit"]').disabled = !entities.length || !predicates.length;
  const classMap = new Map(snapshot.ontology.classes.map(item => [item.id, item.name]));
  const visibleIds = selectedView ? new Set(selectedView.entityIds) : null;
  const nodes = snapshot.graph.entities.filter(entity => !visibleIds || visibleIds.has(entity.id)).map(entity => {
    const button = element('button');
    button.type = 'button';
    button.className = 'graph-node';
    button.dataset.entityId = entity.id;
    button.setAttribute('aria-pressed', String(entity.id === selectedId));
    button.append(element('span', entity.name || entity.id), element('small', entity.classIds.map(value => classMap.get(value) || value).join(', ')));
    button.addEventListener('click', () => { selectedId = entity.id; render(); });
    return button;
  });
  $('graph-nodes').replaceChildren(...nodes);
  renderEntitySearch(snapshot);
  const entityMap = new Map(entities.map(item => [item.id, item.name]));
  const predicateMap = new Map(predicates.map(item => [item.id, item.name]));
  const relationshipIds = new Set(snapshot.graph.relationships.map(item => item.id));
  $('relationships').replaceChildren(...snapshot.graph.relationships.map(relationship => {
    const label = relationship.relationshipTypeId === null
      ? relationship.legacy.label || '(unlabeled)'
      : predicateMap.get(relationship.relationshipTypeId) || relationship.relationshipTypeId;
    const item = element('li', `${entityMap.get(relationship.from)} → ${label} → ${entityMap.get(relationship.to)} (${relationship.status})`);
    item.dataset.relationshipId = relationship.id;
    item.tabIndex = -1;
    const remove = element('button', 'Delete');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Delete relationship ${relationship.id}`);
    remove.addEventListener('click', () => run(async () => {
      if (window.confirm('Delete this relationship?')) await apply([{ type: 'relationship.delete', id: relationship.id }]);
    }));
    if (!readOnly) item.append(remove, relationshipEditor(relationship, entities, predicates),
      propertyEditor(relationship, 'Relationship'), provenanceEditor(relationship, 'Relationship'));
    return item;
  }));
  const inspection = snapshot.graph.entities.some(item => item.id === selectedId)
    ? inspectConnections(snapshot, selectedId) : { connections: [], diagnostics: validateSnapshot(snapshot) };
  renderInspector(snapshot, inspection.connections);
  $('diagnostics').replaceChildren(...inspection.diagnostics
    .filter(item => item.code !== 'VALIDATION_INCOMPLETE')
    .map(diagnostic => {
      const item = element('li', `${diagnostic.severity}: ${diagnostic.message} ${diagnostic.path}`);
      const affectedEntity = entityMap.get(diagnostic.entityId);
      if (diagnostic.path.startsWith('/graph/entities/') && affectedEntity !== undefined) {
        const button = element('button', `Open ${affectedEntity}`);
        button.type = 'button';
        button.setAttribute('aria-label', `Open entity ${affectedEntity} (${diagnostic.entityId})`);
        button.addEventListener('click', () => focusEntity(diagnostic.entityId));
        item.append(' ', button);
      } else if (diagnostic.path.startsWith('/graph/relationships/') && relationshipIds.has(diagnostic.entityId)) {
        const button = element('button', 'Open relationship');
        button.type = 'button';
        button.setAttribute('aria-label', `Open relationship ${diagnostic.entityId}`);
        button.addEventListener('click', () => {
          [...$('relationships').children].find(value => value.dataset.relationshipId === diagnostic.entityId)?.focus();
        });
        item.append(' ', button);
      }
      return item;
    }));
  requestAnimationFrame(drawGraph);
}
function focusEntity(entityId) {
  const view = current.snapshot.views.find(item => item.id === selectedViewId);
  if (view && !view.entityIds.includes(entityId)) selectedViewId = null;
  selectedId = entityId;
  render();
  [...$('graph-nodes').children].find(node => node.dataset.entityId === entityId)?.focus();
}
function renderViewManagement(snapshot, view, readOnly) {
  const container = $('view-management');
  container.replaceChildren();
  if (!view || readOnly) return;
  const details = element('details');
  details.append(element('summary', 'Edit view membership'));
  details.addEventListener('toggle', () => {
    if (!details.open || details.querySelector('form')) return;
    const form = element('form');
    const fieldset = element('fieldset');
    fieldset.append(element('legend', 'Entities in this view'));
    for (const entity of snapshot.graph.entities) {
      const label = element('label');
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      checkbox.value = entity.id;
      checkbox.checked = view.entityIds.includes(entity.id);
      label.append(checkbox, ` ${entity.name || entity.id} (${entity.id})`);
      fieldset.append(label);
    }
    const save = element('button', 'Save view membership');
    form.append(fieldset, save);
    form.addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const updated = clone(view);
        const checked = new Set([...fieldset.querySelectorAll('input:checked')].map(input => input.value));
        updated.entityIds = [
          ...view.entityIds.filter(entityId => checked.delete(entityId)),
          ...snapshot.graph.entities.filter(entity => checked.has(entity.id)).map(entity => entity.id),
        ];
        await apply([{ type: 'view.put', view: updated }]);
        if (selectedId && !updated.entityIds.includes(selectedId)) selectedId = null;
        render();
        if (!$('status').textContent) status('View membership saved.');
        $('view-management').querySelector('summary')?.focus();
      });
    });
    details.append(form);
  });
  const remove = element('button', 'Delete view');
  remove.type = 'button';
  remove.addEventListener('click', () => run(async () => {
    if (!window.confirm(`Delete view ${view.name}? Entities and relationships will remain.`)) return;
    await apply([{ type: 'view.delete', id: view.id }]);
    selectedViewId = null;
    render();
    if (!$('status').textContent) status('View deleted.');
    $('view-choice').querySelector('summary').focus();
  }));
  container.append(details, remove);
}
function renderEntitySearch(snapshot) {
  const query = $('entity-search').value.trim().toLocaleLowerCase();
  const results = $('entity-search-results');
  results.replaceChildren();
  if (!query) {
    $('entity-search-count').textContent = '';
    return;
  }
  const classNames = new Map(snapshot.ontology.classes.map(item => [item.id, item.name]));
  const matches = snapshot.graph.entities.filter(entity => {
    const fields = [entity.id, entity.name, ...entity.classIds.map(value => classNames.get(value) || value),
      JSON.stringify(entity.properties), JSON.stringify(entity.externalIds)];
    return fields.some(field => field.toLocaleLowerCase().includes(query));
  });
  $('entity-search-count').textContent = `${matches.length} ${matches.length === 1 ? 'entity' : 'entities'} found.`;
  for (const entity of matches) {
    const item = element('li');
    const button = element('button', `${entity.name || entity.id} (${entity.id})`);
    button.type = 'button';
    button.addEventListener('click', () => focusEntity(entity.id));
    item.append(button);
    results.append(item);
  }
}
function renderInspector(snapshot, connections) {
  const container = $('inspector');
  container.replaceChildren();
  const entity = snapshot.graph.entities.find(item => item.id === selectedId);
  if (!entity) {
    container.append(element('p', 'Select an entity to edit it.'));
    return;
  }
  container.append(element('p', `ID: ${entity.id}`));
  const entityNames = new Map(snapshot.graph.entities.map(item => [item.id, item.name || item.id]));
  const predicateNames = new Map(snapshot.ontology.relationshipTypes.map(item => [item.id, item.label]));
  const assertions = new Map(snapshot.graph.relationships.map(item => [item.id, item]));
  const section = element('section');
  section.append(element('h4', 'Connections'));
  if (!connections.length) section.append(element('p', 'No connections.'));
  else {
    const list = element('ul');
    for (const connection of connections) {
      const assertion = assertions.get(connection.assertionId);
      const predicate = connection.relationshipTypeId === null
        ? assertion.legacy.label || '(unlabeled)' : predicateNames.get(connection.relationshipTypeId);
      const kind = connection.derived ? 'derived from' : 'stored assertion';
      const item = element('li', `${entityNames.get(connection.from)} → ${predicate} → ${entityNames.get(connection.to)} (${connection.status}; ${kind} ${connection.assertionId})`);
      const other = connection.from === entity.id ? connection.to : connection.from;
      if (other !== entity.id) {
        const button = element('button', `Open ${entityNames.get(other)}`);
        button.type = 'button';
        button.setAttribute('aria-label', `Open ${entityNames.get(other)} (${other})`);
        button.addEventListener('click', () => focusEntity(other));
        item.append(' ', button);
      }
      list.append(item);
    }
    section.append(list);
  }
  container.append(section);
  const transitive = transitivePathExplorer(snapshot, entity);
  if (transitive) container.append(transitive);
  if (current.role === 'viewer') {
    container.append(element('p', entity.name), element('p', `Status: ${entity.status}`));
    const data = element('pre', JSON.stringify({ properties: entity.properties, provenance: entity.provenance }, null, 2));
    container.append(data);
    return;
  }
  const form = element('form');
  const label = element('label', 'Entity name');
  const input = element('textarea');
  input.rows = 1;
  input.value = entity.name;
  input.required = true;
  label.append(input);
  const save = element('button', 'Save name');
  form.append(label, save);
  form.addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      const name = input.value.trim();
      if (!name) throw new Error('Enter an entity name.');
      await apply([{ type: 'entity.put', entity: { ...entity, name } }]);
    });
  });
  const remove = element('button', 'Delete entity');
  remove.type = 'button';
  remove.addEventListener('click', () => run(async () => {
    if (!window.confirm('Delete this entity and its relationships?')) return;
    const operations = snapshot.graph.relationships
      .filter(item => item.from === entity.id || item.to === entity.id)
      .map(item => ({ type: 'relationship.delete', id: item.id }));
    for (const view of snapshot.views) {
      if (!view.entityIds.includes(entity.id) && !Object.hasOwn(view.positions, entity.id)) continue;
      const updated = clone(view);
      updated.entityIds = updated.entityIds.filter(value => value !== entity.id);
      delete updated.positions[entity.id];
      operations.push({ type: 'view.put', view: updated });
    }
    operations.push({ type: 'entity.delete', id: entity.id });
    await apply(operations);
    selectedId = null;
    render();
  }));
  container.append(form, connectedEntityEditor(entity), classEditor(entity, snapshot.ontology.classes), propertyEditor(entity, 'Entity'),
    provenanceEditor(entity, 'Entity'), remove);
  growField(input);
}
function transitivePathExplorer(snapshot, source) {
  const predicates = snapshot.ontology.relationshipTypes.filter(type => type.transitive);
  if (!predicates.length) return null;
  const details = element('details');
  details.append(element('summary', 'Explore transitive paths'));
  details.addEventListener('toggle', () => {
    if (!details.open || details.querySelector('form')) return;
    const form = element('form');
    const choice = element('details');
    choice.dataset.label = 'Transitive predicate';
    selectOptions(choice, predicates.map(type => ({ id: type.id, name: `${type.label} (${type.id})` })), 'Choose a predicate');
    const results = element('div');
    results.setAttribute('aria-live', 'polite');
    form.append(element('span', 'Transitive predicate'), choice, element('button', 'Find transitive paths'), results);
    form.addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        results.replaceChildren();
        const found = inferTransitivePaths(snapshot, { sourceId: source.id, relationshipTypeId: choice.dataset.value });
        const names = new Map(snapshot.graph.entities.map(entity => [entity.id, entity.name || entity.id]));
        results.append(element('p', `${found.paths.length} derived ${found.paths.length === 1 ? 'path' : 'paths'} within 4 links${found.truncated ? ' (limit reached)' : ''}.`));
        const list = element('ul');
        for (const path of found.paths) {
          const item = element('li', path.entityIds.map(entityId => `${names.get(entityId)} (${entityId})`).join(' → '));
          const targetId = path.entityIds[path.entityIds.length - 1];
          const target = element('button', `Open ${names.get(targetId)} (${targetId})`);
          target.type = 'button';
          target.addEventListener('click', () => focusEntity(targetId));
          item.append(' ', target);
          for (const assertionId of path.assertionIds) {
            const assertion = element('button', `Open assertion ${assertionId}`);
            assertion.type = 'button';
            assertion.addEventListener('click', () => {
              [...$('relationships').children].find(value => value.dataset.relationshipId === assertionId)?.focus();
            });
            item.append(' ', assertion);
          }
          list.append(item);
        }
        results.append(list);
      });
    });
    details.append(form);
  });
  return details;
}
function connectedEntityEditor(source) {
  const details = element('details');
  details.dataset.connectedEntity = '';
  details.append(element('summary', 'Add connected entity'));
  details.addEventListener('toggle', () => {
    if (!details.open || details.querySelector('form')) return;
    const form = element('form');
    const label = element('label', 'New entity name');
    const name = element('textarea');
    name.rows = 1;
    name.required = true;
    label.append(name);
    const classChoice = element('details');
    classChoice.dataset.label = 'New entity class';
    const classes = current.snapshot.ontology.classes.filter(item => !item.abstract)
      .map(item => ({ id: item.id, name: `${item.name} (${item.id})` }));
    selectOptions(classChoice, classes, 'Add a class first');
    const predicateChoice = element('details');
    predicateChoice.dataset.label = 'Connecting predicate';
    const predicates = current.snapshot.ontology.relationshipTypes
      .map(item => ({ id: item.id, name: `${item.label} (${item.id})` }));
    selectOptions(predicateChoice, predicates, 'Add a predicate first');
    const save = element('button', 'Create connected entity');
    save.disabled = !classes.length || !predicates.length;
    form.append(label, element('span', 'New entity class'), classChoice,
      element('span', 'Connecting predicate'), predicateChoice, save);
    form.addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const entityName = name.value.trim(), classId = classChoice.dataset.value;
        const relationshipTypeId = predicateChoice.dataset.value;
        if (!entityName || !classId || !relationshipTypeId) throw new Error('Enter a name and choose a class and predicate.');
        const entity = { id: id(), name: entityName, classIds: [classId], properties: {}, externalIds: [], provenance: [], status: 'active' };
        const relationship = {
          id: id(), from: source.id, to: entity.id, relationshipTypeId, properties: {}, provenance: [], status: 'asserted',
        };
        await apply([...createEntityOperations(current.snapshot, entity), { type: 'relationship.put', relationship }]);
        if (!$('status').textContent) status('Connected entity added.');
        focusEntity(entity.id);
      });
    });
    details.append(form);
    growField(name);
  });
  return details;
}
function addEnumChoice() {
  const row = element('div');
  const label = element('label', 'Choice');
  const field = element('textarea');
  field.rows = 1;
  label.append(field);
  const remove = element('button', 'Remove choice');
  remove.type = 'button';
  remove.addEventListener('click', () => {
    row.remove();
    labelEnumChoices();
    $('add-enum-value').focus();
  });
  row.append(label, remove);
  $('property-enum-values').append(row);
  labelEnumChoices();
  return field;
}
function labelEnumChoices() {
  [...$('property-enum-values').children].forEach((row, index) => {
    row.querySelector('label').firstChild.textContent = `Choice ${index + 1}`;
    row.querySelector('button').setAttribute('aria-label', `Remove choice ${index + 1}`);
  });
}
function updatePropertyOptions() {
  const type = $('property-type').dataset.value;
  const itemType = $('property-item-type').dataset.value;
  $('property-list-options').hidden = type !== 'list';
  $('property-enum-options').hidden = type !== 'enum' && !(type === 'list' && itemType === 'enum');
}
function drawGraph() {
  if (!current || $('editor').hidden) return;
  const graph = $('graph'), svg = $('graph-lines'), bounds = graph.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${graph.scrollWidth} ${graph.scrollHeight}`);
  const positions = new Map();
  for (const node of $('graph-nodes').children) {
    const rect = node.getBoundingClientRect();
    positions.set(node.dataset.entityId, {
      x: rect.left - bounds.left + graph.scrollLeft + rect.width / 2,
      y: rect.top - bounds.top + graph.scrollTop + rect.height / 2,
      width: rect.width, height: rect.height,
    });
  }
  renderGraphLines(svg, positions);
}

async function initialize() {
    store = await openLocalV2Store('nodeboard-v2-local');
    activeStore = store;
    $('view-choice').addEventListener('change', () => {
      selectedViewId = $('view-choice').dataset.value === '@all' ? null : $('view-choice').dataset.value;
      if (selectedViewId) {
        const view = current.snapshot.views.find(item => item.id === selectedViewId);
        if (selectedId && !view?.entityIds.includes(selectedId)) selectedId = null;
      }
      render();
      $('view-choice').querySelector('summary').focus();
    });
    $('create-view-form').addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const name = $('view-name').value.trim();
        if (!name) throw new Error('Enter a view name.');
        const source = current.snapshot.views.find(view => view.id === selectedViewId);
        const view = source ? { ...clone(source), id: id(), name } : {
          id: id(), name, scope: 'shared', query: {},
          entityIds: current.snapshot.graph.entities.map(entity => entity.id),
          positions: {}, viewport: { x: 0, y: 0, zoom: 1 },
        };
        await apply([{ type: 'view.put', view }]);
        selectedViewId = view.id;
        clearField($('view-name'));
        render();
        if (!$('status').textContent) status('View saved.');
        $('view-choice').querySelector('summary').focus();
      });
    });
    selectOptions($('property-type'), propertyTypes.map(value => ({ id: value, name: value })), 'Data type');
    selectOptions($('property-item-type'), propertyTypes.filter(value => value !== 'list')
      .map(value => ({ id: value, name: value })), 'List item type');
    addEnumChoice();
    $('property-type').addEventListener('change', updatePropertyOptions);
    $('property-item-type').addEventListener('change', updatePropertyOptions);
    $('add-enum-value').addEventListener('click', () => addEnumChoice().focus());
    $('add-property-form').addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const name = $('property-name').value.trim();
        const dataType = $('property-type').dataset.value;
        if (!name || !propertyTypes.includes(dataType)) throw new Error('Enter a property name and choose its data type.');
        const definition = { id: id(), name, dataType };
        if (dataType === 'list') definition.listItemType = $('property-item-type').dataset.value;
        if (dataType === 'enum' || (dataType === 'list' && definition.listItemType === 'enum')) {
          definition.enumValues = [...$('property-enum-values').querySelectorAll('textarea')].map(field => field.value);
          if (!definition.enumValues.length) throw new Error('Add at least one choice.');
        }
        const ontology = clone(current.snapshot.ontology);
        ontology.propertyDefinitions.push(definition);
        await apply([{ type: 'ontology.replace', ontology }]);
        clearField($('property-name'));
        $('property-enum-values').replaceChildren();
        addEnumChoice();
        if (!$('status').textContent) status('Property added.');
      });
    });
    $('ontology-editor').addEventListener('toggle', () => {
      if ($('ontology-editor').open && current && !ontologyDraft) loadOntologyDraft();
    });
    $('ontology-json').addEventListener('input', clearOntologyPreview);
    $('ontology-load').addEventListener('click', () => run(async () => {
      if (ontologyDraft && $('ontology-json').value !== ontologyDraft.text &&
          !window.confirm('Replace the unsaved ontology draft with the current ontology?')) return;
      loadOntologyDraft();
    }));
    $('ontology-preview').addEventListener('click', () => run(async () => {
      clearOntologyPreview();
      if (!current || !ontologyDraft || ontologyDraft.boardId !== current.id || ontologyDraft.revision !== current.revision) {
        throw new Error('The board changed since the ontology was loaded. Load the current ontology before editing.');
      }
      const text = $('ontology-json').value;
      let ontology;
      try { ontology = JSON.parse(text); }
      catch { throw new Error('The ontology is not valid JSON.'); }
      const diagnostics = validateSnapshot({ ...current.snapshot, ontology })
        .filter(item => item.code !== 'VALIDATION_INCOMPLETE');
      const blocked = diagnostics.some(item => item.severity === 'error');
      const report = $('ontology-report');
      report.append(element('p', blocked ? 'Ontology changes cannot be applied.' : 'Ontology preview:'));
      const findings = element('ul');
      let changes = [];
      if (!blocked) {
        changes = ontologyChanges(current.snapshot.ontology, ontology);
        for (const change of changes) findings.append(element('li', change));
        if (!changes.length) findings.append(element('li', 'No ontology changes.'));
      }
      for (const item of diagnostics) {
        findings.append(element('li', `${item.severity}: ${item.code} ${item.path || '/'}: ${item.message}`));
      }
      report.append(findings);
      if (!blocked && changes.length) {
        ontologyPreview = { ontology, text, revision: current.revision, boardId: current.id };
        $('ontology-apply').disabled = false;
      }
    }));
    $('ontology-apply').addEventListener('click', () => run(async () => {
      if (!ontologyPreview || !current || ontologyPreview.boardId !== current.id ||
          ontologyPreview.revision !== current.revision || ontologyPreview.text !== $('ontology-json').value) {
        throw new Error('Preview the current ontology changes before applying them.');
      }
      await apply([{ type: 'ontology.replace', ontology: ontologyPreview.ontology }]);
      loadOntologyDraft();
      if (!$('status').textContent) status('Ontology changes applied.');
      $('ontology-preview').focus();
    }));
    $('home-button').addEventListener('click', () => run(showHome));
    $('entity-search').addEventListener('input', () => {
      if (current) renderEntitySearch(current.snapshot);
    });
    $('more-boards').addEventListener('click', () => run(() => loadBoards(nextAfter)));
    $('more-cloud-boards').addEventListener('click', () => run(() => loadCloudBoards(cloudNextAfter)));
    $('open-sharing').addEventListener('click', () => run(async () => {
      if (!current || activeStore !== cloudStore || current.role !== 'owner' || !accountUser) {
        throw new Error('Open an account board you own to manage sharing.');
      }
      const source = activeStore, boardId = current.id;
      const link = new URL('v2.html', location.href);
      link.search = '';
      link.hash = '';
      link.searchParams.set('sharedOwner', accountUser.id);
      link.searchParams.set('sharedBoard', boardId);
      $('sharing-link').value = link.href;
      $('sharing-panel').hidden = false;
      growField($('sharing-link'));
      await loadMembers(source, boardId);
    }));
    $('close-sharing').addEventListener('click', () => { $('sharing-panel').hidden = true; });
    $('sharing-form').addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        if (!current || activeStore !== cloudStore || current.role !== 'owner') throw new Error('Open an account board you own to manage sharing.');
        const source = activeStore, boardId = current.id;
        const email = $('sharing-email').value.trim().toLowerCase();
        const role = document.querySelector('input[name="sharing-role"]:checked')?.value;
        if (!email || !role) throw new Error('Enter an account email and choose an access role.');
        await source.share(boardId, email, role);
        await loadMembers(source, boardId);
        clearField($('sharing-email'));
        status('Access granted.');
      });
    });
    $('account-email').addEventListener('input', () => {
      if ($('account-email').value.trim().toLowerCase() !== codeEmail) {
        $('account-code-form').hidden = true;
        $('account-code').value = '';
      }
    });
    $('account-email-form').addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        if (!accountClient) throw new Error('The account service is unavailable.');
        const email = $('account-email').value.trim().toLowerCase();
        if (!email) throw new Error('Enter an email address.');
        const result = await accountClient.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
        if (result.error) throw result.error;
        codeEmail = email;
        $('account-code-form').hidden = $('account-email').value.trim().toLowerCase() !== email;
        status(`If the address can receive email, a sign-in code has been sent to ${email}.`);
        if (!$('account-code-form').hidden) $('account-code').focus();
      });
    });
    $('account-code-form').addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        if (!accountClient || !codeEmail) throw new Error('Request a sign-in code first.');
        const token = $('account-code').value.trim();
        if (!token) throw new Error('Enter the sign-in code.');
        const result = await accountClient.auth.verifyOtp({ email: codeEmail, token, type: 'email' });
        if (result.error) throw result.error;
        $('account-code').value = '';
        $('account-code-form').hidden = true;
        codeEmail = '';
        await updateAccount();
      });
    });
    $('account-sign-out').addEventListener('click', () => run(async () => {
      if (!accountClient) throw new Error('The account service is unavailable.');
      const result = await accountClient.auth.signOut();
      if (result.error) throw result.error;
      await updateAccount();
    }));
    $('copy-to-account').addEventListener('click', () => run(async () => {
      if (!current || !cloudStore || activeStore !== store) throw new Error('Sign in before copying a local board to your account.');
      const boardId = current.id, accountId = accountUser.id, destination = cloudStore;
      const source = await store.read(boardId);
      if (!source) throw new Error('The local board does not exist.');
      const pending = await pendingStore();
      if (destination !== cloudStore || accountUser?.id !== accountId || current?.id !== boardId || activeStore !== store) {
        throw new Error('The board or account changed. Try the copy again.');
      }
      const record = { accountId, boardId, kind: 'create', payload: { id: id(), snapshot: source.snapshot } };
      try { await pending.addCopy(record); }
      catch (error) {
        setPendingCopy(destination, boardId, await pending.getCopy(accountId, boardId));
        throw error;
      }
      setPendingCopy(destination, boardId, record);
      const copied = await sendPendingCopy(destination, record);
      if (destination !== cloudStore || current?.id !== boardId || activeStore !== store) {
        throw new Error('The account or board changed after the copy was created. Open the account board to continue.');
      }
      await openBoard(copied.id, destination);
      status('Board copied to your account.');
    }));
    $('retry-cloud-copy').addEventListener('click', () => run(async () => {
      if (!current || !accountUser || !cloudStore || activeStore !== store) throw new Error('Open the local board and sign in before retrying.');
      const boardId = current.id, accountId = accountUser.id, destination = cloudStore;
      const record = await (await pendingStore()).getCopy(accountId, boardId);
      if (!record) {
        setPendingCopy(destination, boardId, null);
        status('There is no pending account copy.');
        return;
      }
      const copied = await sendPendingCopy(destination, record);
      if (destination !== cloudStore || current?.id !== boardId || activeStore !== store) {
        throw new Error('The account or board changed after the copy was created. Open the account board to continue.');
      }
      await openBoard(copied.id, destination);
      status('Board copied to your account.');
    }));
    $('copy-to-local').addEventListener('click', () => run(async () => {
      if (!current || activeStore === store) throw new Error('Open an account board to copy it locally.');
      const copied = await store.create(id(), current.snapshot);
      await openBoard(copied.id);
      status('Displayed board copied locally.');
    }));
    $('retry-cloud-change').addEventListener('click', () => run(async () => {
      if (!current || !accountUser || !isAccountStore(activeStore)) throw new Error('Open the account board before retrying.');
      const source = activeStore, boardId = current.id;
      const key = await pendingBoardKey(source, boardId);
      const pending = await (await pendingStore()).get(accountUser.id, key);
      if (!pending) {
        setPendingChange(source, boardId, null);
        status('There is no pending account change.');
        return;
      }
      const result = await sendPendingChange(source, pending);
      if (!current || current.id !== boardId || activeStore !== source || !isAccountStore(source)) {
        throw new Error('The board changed while retrying. Reopen it to check whether the operation was saved.');
      }
      current = result;
      if (result.historyTruncated) status('Older history was removed to stay within storage limits.');
      else status('Pending account change saved.');
      render();
    }));
    $('export-cloud-change').addEventListener('click', () => run(async () => {
      const { source, boardId, accountId, record } = await currentPendingChange();
      if (!record) { status('There is no pending account change.'); return; }
      downloadJson({
        format: 'nodeboard-pending-change', version: 1, accountId,
        ownerId: source.ownerId || accountId, boardId, kind: record.kind, payload: record.payload,
      }, `nodeboard-pending-${boardId}.json`);
      status('Pending account change exported.');
    }));
    $('discard-cloud-change').addEventListener('click', () => run(async () => {
      const { source, boardId, accountId, key, pending, record } = await currentPendingChange();
      if (!record) { status('There is no pending account change.'); return; }
      if (!window.confirm('This change may already have been saved. Discarding stops retries and does not undo a saved change. Unsaved changes in this request will be lost. Continue?')) return;
      const board = await source.read(boardId);
      checkPendingContext(source, boardId, accountId);
      if (!board) throw new Error('The account board is unavailable.');
      const removed = await pending.remove(accountId, key, record.payload.operationId);
      checkPendingContext(source, boardId, accountId);
      setPendingChange(source, boardId, await pending.get(accountId, key));
      checkPendingContext(source, boardId, accountId);
      if (!removed) throw new Error('The pending change changed in another tab. Review the current pending change.');
      current = board;
      render();
      status('Pending retry discarded; the latest account board is displayed.');
    }));
    $('create-board-form').addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const name = $('board-name').value.trim();
        if (!name) throw new Error('Enter a board name.');
        const board = await store.create(id(), blankSnapshot(name));
        clearField($('board-name'));
        await openBoard(board.id);
      });
    });
    $('preview-migration').addEventListener('click', () => run(async () => {
      migration = null;
      $('confirm-migration').hidden = true;
      $('migration-report').replaceChildren();
      const preview = await prepareLocalV1Migration(window.localStorage);
      const report = preview.report.counts;
      $('migration-report').append(element('p',
        `${report.classes} classes, ${report.entities} entities, ${report.relationships} relationships, ${report.unresolvedRelationships} unresolved.`));
      const findings = preview.diagnostics.filter(item => item.code !== 'VALIDATION_INCOMPLETE');
      if (findings.length) {
        const list = element('ul');
        list.replaceChildren(...findings.map(item => element('li', `${item.severity}: ${item.message} ${item.path}`)));
        $('migration-report').append(list);
      }
      if (preview.ok) {
        migration = preview;
        $('confirm-migration').hidden = false;
      }
    }));
    $('confirm-migration').addEventListener('click', () => run(async () => {
      if (!migration) throw new Error('Prepare an import preview first.');
      const board = await migration.commit(store, id());
      migration = null;
      $('confirm-migration').hidden = true;
      $('migration-report').replaceChildren();
      await openBoard(board.id);
    }));
    $('restore-file').addEventListener('change', event => {
      const file = event.target.files[0];
      if (!file) return;
      run(async () => {
        try {
          const backup = await readJsonFile(file, 10000000, 'backup');
          const board = await store.restoreAsNew(id(), backup);
          await openBoard(board.id);
        } finally { event.target.value = ''; }
      });
    });
    $('import-native').addEventListener('change', event => {
      const file = event.target.files[0];
      if (!file) return;
      run(async () => {
        try {
          const snapshot = await readJsonFile(file, 10000000, 'native board');
          const board = await store.create(id(), snapshot);
          await openBoard(board.id);
        } finally { event.target.value = ''; }
      });
    });
    $('backup-button').addEventListener('click', () => run(async () => {
      if (!current) return;
      const backup = await activeStore.exportBackup(current.id);
      downloadJson(backup, `nodeboard-${current.id}.json`);
    }));
    $('export-native').addEventListener('click', () => run(async () => {
      if (!current) return;
      const board = await activeStore.read(current.id);
      if (!board) {
        if (activeStore !== store) {
          await showHome();
          status('The account board is unavailable or access has ended.');
          return;
        }
        throw new Error('The board does not exist.');
      }
      downloadJson(board.snapshot, `nodeboard-${board.id}.nodeboard.json`);
    }));
    $('reload-board').addEventListener('click', () => run(async () => {
      if (!current) return;
      const board = await activeStore.read(current.id);
      if (!board) {
        if (activeStore !== store) {
          await showHome();
          status('The account board is unavailable or access has ended.');
          return;
        }
        throw new Error('The board does not exist.');
      }
      current = board;
      render();
    }));
    for (const direction of ['undo', 'redo']) {
      $(`${direction}-button`).addEventListener('click', () => run(async () => {
        if (!current) return;
        const source = activeStore, boardId = current.id;
        const result = source === store ? await source[direction](boardId, current.revision)
          : await submitCloudChange(source, boardId, 'history', {
            operationId: id(), baseRevision: current.revision, direction,
          });
        if (!current || current.id !== boardId || activeStore !== source || (source !== store && !isAccountStore(source))) {
          throw new Error('The board changed while history was pending. Reopen it to check whether the action was saved.');
        }
        current = result;
        if (result.historyTruncated) status('Older history was removed to stay within storage limits.');
        render();
      }));
    }
    $('add-class-form').addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const name = $('class-name').value.trim();
        if (!name) throw new Error('Enter a class name.');
        const ontology = clone(current.snapshot.ontology);
        ontology.classes.push({ id: id(), name, superclassIds: [], abstract: false, propertyDefinitionIds: [] });
        await apply([{ type: 'ontology.replace', ontology }]);
        clearField($('class-name'));
      });
    });
    $('add-predicate-form').addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const name = $('predicate-name').value.trim();
        if (!name) throw new Error('Enter a predicate name.');
        const ontology = clone(current.snapshot.ontology);
        ontology.relationshipTypes.push({
          id: id(), predicate: name, label: name, domainClassIds: [], rangeClassIds: [],
          inversePredicateId: null, symmetric: false, transitive: false,
        });
        await apply([{ type: 'ontology.replace', ontology }]);
        clearField($('predicate-name'));
      });
    });
    $('add-required-form').addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const classId = $('required-class').dataset.value, propertyId = $('required-property').dataset.value;
        if (!classId || !propertyId) throw new Error('Choose a class and property.');
        const ontology = clone(current.snapshot.ontology);
        if (ontology.constraints.some(item => item.kind === 'required' &&
            item.parameters.classId === classId && item.parameters.propertyId === propertyId)) {
          throw new Error('This class already requires that property.');
        }
        ontology.constraints.push({ id: id(), kind: 'required', parameters: { classId, propertyId } });
        await apply([{ type: 'ontology.replace', ontology }]);
        if (!$('status').textContent) status('Required property added.');
      });
    });
    $('add-entity-form').addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const name = $('entity-name').value.trim(), classId = $('entity-class').dataset.value;
        if (!name || !classId) throw new Error('Enter an entity name and choose a class.');
        const entity = { id: id(), name, classIds: [classId], properties: {}, externalIds: [], provenance: [], status: 'active' };
        await apply(createEntityOperations(current.snapshot, entity));
        clearField($('entity-name'));
      });
    });
    $('add-relationship-form').addEventListener('submit', event => {
      event.preventDefault();
      run(async () => {
        const from = $('relationship-from').dataset.value, to = $('relationship-to').dataset.value;
        const relationshipTypeId = $('relationship-type').dataset.value;
        if (!from || !to || !relationshipTypeId) throw new Error('Choose a source, predicate and target.');
        await apply([{ type: 'relationship.put', relationship: {
          id: id(), from, to, relationshipTypeId, properties: {}, provenance: [], status: 'asserted',
        } }]);
      });
    });
    document.addEventListener('input', event => {
      if (event.target instanceof HTMLTextAreaElement) growField(event.target);
    });
    window.addEventListener('resize', () => {
      for (const field of document.querySelectorAll('textarea')) growField(field);
      drawGraph();
    });
    $('graph').addEventListener('scroll', drawGraph);
    await loadBoards();
    try { await initializeAccounts(); }
    catch (error) { status(errorText(error)); }
    document.documentElement.dataset.v2Ready = 'true';
  }

initialize().catch(error => status(errorText(error)));

function renderGraphLines(svg, positions) {
  const defs = document.createElementNS(svgNS, 'defs');
  const marker = document.createElementNS(svgNS, 'marker');
  marker.setAttribute('id', 'arrow');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '9');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '6');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('orient', 'auto');
  const arrow = document.createElementNS(svgNS, 'path');
  arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  arrow.setAttribute('fill', '#56739a');
  marker.append(arrow);
  defs.append(marker);
  svg.replaceChildren(defs);
  const groups = new Map();
  for (const relationship of current.snapshot.graph.relationships) {
    const key = JSON.stringify([relationship.from, relationship.to].sort());
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(relationship);
  }
  for (const relationships of groups.values()) relationships.forEach((relationship, index) => {
    const from = positions.get(relationship.from), to = positions.get(relationship.to);
    if (!from || !to) return;
    const offset = (index - (relationships.length - 1) / 2) * 22;
    const path = document.createElementNS(svgNS, 'path');
    if (relationship.from === relationship.to) {
      const x = from.x, y = from.y - from.height / 2;
      path.setAttribute('d', `M ${x - 15} ${y} C ${x - 50 - index * 10} ${y - 60} ${x + 50 + index * 10} ${y - 60} ${x + 15} ${y}`);
    } else {
      const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy) || 1;
      const start = Math.min(dx ? (from.width / 2 + 5) / Math.abs(dx) : Infinity, dy ? (from.height / 2 + 5) / Math.abs(dy) : Infinity);
      const end = Math.min(dx ? (to.width / 2 + 7) / Math.abs(dx) : Infinity, dy ? (to.height / 2 + 7) / Math.abs(dy) : Infinity);
      const sign = relationship.from < relationship.to ? 1 : -1;
      const midX = (from.x + to.x) / 2 - dy / length * offset * sign;
      const midY = (from.y + to.y) / 2 + dx / length * offset * sign;
      path.setAttribute('d', `M ${from.x + dx * start} ${from.y + dy * start} Q ${midX} ${midY} ${to.x - dx * end} ${to.y - dy * end}`);
    }
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#56739a');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('marker-end', 'url(#arrow)');
    svg.append(path);
  });
}
