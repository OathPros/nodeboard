const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');

const app = path.resolve(__dirname, '../../nodeboard-live-starter');
const { chromium } = createRequire(path.join(app, 'package.json'))('playwright');
const candidate = process.env.NODEBOARD_CYTOSCAPE_JS;
if (!candidate) throw new Error('Set NODEBOARD_CYTOSCAPE_JS to the isolated cytoscape.min.js path.');

function elements(nodeCount, edgeCount) {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    data: { id: `node-${i}`, label: `Item ${i}` },
    position: { x: (i % 50) * 260, y: Math.floor(i / 50) * 140 },
  }));
  const edges = Array.from({ length: edgeCount }, (_, i) => ({
    data: { id: `edge-${i}`, source: `node-${i % nodeCount}`, target: `node-${(i * 13 + 1) % nodeCount}`, label: 'RELATES_TO' },
  }));
  return nodes.concat(edges);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  console.log(`Chromium ${browser.version()}; viewport 1280x800; fresh browser contexts`);
  let version;
  try {
    for (const [nodes, edges] of [[300, 550], [3000, 6000]]) {
      const results = [];
      for (let trial = 0; trial < 3; trial++) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        try {
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          await page.setContent('<style>html,body,#graph{width:100%;height:100%;margin:0}</style><div id="graph"></div>');
          await page.addScriptTag({ path: candidate });
          const currentVersion = await page.evaluate(() => window.cytoscape.version);
          if (!version) {
            version = currentVersion;
            console.log(`Cytoscape ${version}`);
          }
          assert.equal(currentVersion, version, 'renderer version');
          const started = performance.now();
          await page.evaluate(data => {
            window.cy = window.cytoscape({
              container: document.getElementById('graph'),
              elements: data,
              layout: { name: 'preset', fit: true },
              style: [
                { selector: 'node', style: { label: 'data(label)', width: 154, height: 77, shape: 'round-rectangle', 'font-size': 14, 'text-valign': 'center', 'background-color': '#475569' } },
                { selector: 'edge', style: { label: 'data(label)', 'font-size': 10, 'curve-style': 'bezier', 'target-arrow-shape': 'triangle' } },
              ],
            });
          }, elements(nodes, edges));
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          results.push(Math.round(performance.now() - started));
          const actual = await page.evaluate(() => ({ nodes: window.cy.nodes().length, edges: window.cy.edges().length }));
          assert.deepEqual(actual, { nodes, edges });
          assert.equal(await page.evaluate(count => {
            const first = window.cy.getElementById('edge-0');
            const parallel = window.cy.getElementById(`edge-${count}`);
            return first.source().id() === parallel.source().id() && first.target().id() === parallel.target().id();
          }, nodes), true, 'parallel edges retained');
          await page.evaluate(() => {
            window.cy.zoom(1);
            window.cy.center(window.cy.getElementById('node-0'));
          });
          const position = await page.evaluate(() => window.cy.getElementById('node-0').renderedPosition());
          await page.mouse.click(position.x, position.y);
          assert.equal(await page.evaluate(() => window.cy.getElementById('node-0').selected()), true, 'node selectable');
          assert.deepEqual(errors, [], 'uncaught browser errors');
        } finally {
          await context.close();
        }
      }
      console.log(`${nodes} nodes / ${edges} edges: ${results.join(', ')} ms (initialize through two animation frames)`);
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
