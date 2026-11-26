import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { validateSnapshot } from '../../nodeboard-live-starter/src/domain/validate-v2.js';

const snapshot = JSON.parse(readFileSync(new URL('../fixtures/v2-draft-valid.json', import.meta.url), 'utf8'));
const entity = snapshot.graph.entities[0];
const relationship = snapshot.graph.relationships[0];
snapshot.graph.entities = Array.from({ length: 3000 }, (_, i) => ({ ...entity, id: `e${i}` }));
snapshot.graph.relationships = Array.from({ length: 6000 }, (_, i) => ({
  ...relationship, id: `r${i}`, from: `e${i % 3000}`, to: `e${(i + 1) % 3000}`,
}));
snapshot.views = [];

for (let trial = 1; trial <= 3; trial++) {
  const start = performance.now();
  const diagnostics = validateSnapshot(snapshot);
  const elapsed = Math.round(performance.now() - start);
  if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    console.error(JSON.stringify(diagnostics));
    process.exitCode = 1;
    break;
  }
  console.log(`Trial ${trial}: ${elapsed} ms; ${Buffer.byteLength(JSON.stringify(snapshot))} bytes; ${diagnostics.length} warning(s)`);
}
