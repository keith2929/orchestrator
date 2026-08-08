// coding-probes.mjs — the problem set used by rank-coding.mjs.
//
// Kept separate from the runner so the problems can be read, reviewed and
// extended without touching the scoring machinery.
//
// What makes a good probe here:
//   - SMALL enough that a weak model can attempt it in one reply (no multi-file
//     scaffolding), but with edge cases a weak model actually misses.
//   - DETERMINISTIC and dependency-free, so `node test.cjs` is the whole judge.
//   - Weighted by assertion, not by problem: a model that gets 3 of 4 CSV cases
//     right is meaningfully better than one that gets none, and per-problem
//     pass/fail would throw that signal away.
//
// These are deliberately close to work this orchestrator actually does
// (dependency ordering, CSV/context parsing) rather than puzzle-style questions.

export const PROBES = [
  {
    name: 'chunk',
    // Baseline. A model that fails this cannot be trusted with a Worker task.
    prompt:
      'Write a JavaScript function `chunk(arr, size)` that splits an array into ' +
      'consecutive sub-arrays of at most `size` elements. The final chunk may be shorter. ' +
      'chunk([], n) returns [].',
    exportName: 'chunk',
    tests: `
      eq(chunk([1,2,3,4,5], 2), [[1,2],[3,4],[5]], 'uneven split');
      eq(chunk([], 3), [], 'empty input');
      eq(chunk([1,2,3], 5), [[1,2,3]], 'size larger than input');
      eq(chunk([1,2,3,4], 2), [[1,2],[3,4]], 'even split');
    `,
  },
  {
    name: 'topoSort',
    // The orchestrator's own dependency-ordering problem.
    prompt:
      'Write a JavaScript function `topoSort(tasks)` where `tasks` is an array of ' +
      '{ id, depends_on } objects and `depends_on` is an array of ids. Return an array of ' +
      'ids ordered so every task appears after all of its dependencies. ' +
      'Throw an Error if the dependencies contain a cycle.',
    exportName: 'topoSort',
    tests: `
      const chain = [{id:'c',depends_on:['b']},{id:'b',depends_on:['a']},{id:'a',depends_on:[]}];
      eq(topoSort(chain), ['a','b','c'], 'linear chain');

      const diamond = [
        {id:'d',depends_on:['b','c']},{id:'b',depends_on:['a']},
        {id:'c',depends_on:['a']},{id:'a',depends_on:[]},
      ];
      const order = topoSort(diamond);
      ok(order.length === 4, 'diamond keeps every task');
      ok(order.indexOf('a') < order.indexOf('b'), 'diamond a before b');
      ok(order.indexOf('b') < order.indexOf('d') && order.indexOf('c') < order.indexOf('d'), 'diamond deps before d');

      eq(topoSort([{id:'x',depends_on:[]}]), ['x'], 'single task');
      throws(() => topoSort([{id:'a',depends_on:['b']},{id:'b',depends_on:['a']}]), 'cycle throws');
    `,
  },
  {
    name: 'parseCsvLine',
    // Quoting rules are where careless implementations fall over.
    prompt:
      'Write a JavaScript function `parseCsvLine(line)` that parses ONE line of CSV into an ' +
      'array of field strings. Fields are comma-separated. A field may be wrapped in double ' +
      'quotes, in which case it can contain commas, and a doubled quote ("") inside it means a ' +
      'literal double-quote character. Surrounding quotes are not part of the value. ' +
      'Empty fields produce empty strings.',
    exportName: 'parseCsvLine',
    tests: `
      eq(parseCsvLine('a,b,c'), ['a','b','c'], 'plain fields');
      eq(parseCsvLine('a,"b,c",d'), ['a','b,c','d'], 'comma inside quotes');
      eq(parseCsvLine('a,"b""c",d'), ['a','b"c','d'], 'escaped quote');
      eq(parseCsvLine('a,,b'), ['a','','b'], 'empty field');
      eq(parseCsvLine('""'), [''], 'empty quoted field');
    `,
  },
  {
    name: 'LRUCache',
    // Stateful, and the "a read counts as a use" rule is easy to miss.
    prompt:
      'Write a JavaScript class `LRUCache` with `constructor(capacity)`, `get(key)` and ' +
      '`put(key, value)`. It holds at most `capacity` entries; adding one beyond capacity ' +
      'evicts the least-recently-used entry. BOTH get and put count as using a key. ' +
      'get returns undefined for a missing key.',
    exportName: 'LRUCache',
    tests: `
      const c = new LRUCache(2);
      c.put('a', 1); c.put('b', 2);
      ok(c.get('a') === 1, 'reads a stored value');
      c.put('c', 3);                       // 'b' is now least-recently-used
      ok(c.get('b') === undefined, 'evicts least-recently-used');
      ok(c.get('a') === 1, 'keeps recently-read key');
      ok(c.get('c') === 3, 'keeps newest key');

      const d = new LRUCache(1);
      d.put('x', 1); d.put('x', 2);
      ok(d.get('x') === 2, 'overwrites without evicting itself');
    `,
  },
];

// Total assertions across the set — the denominator for a model's score.
// Keep in step with the probes above (4 + 6 + 5 + 5).
export const TOTAL_ASSERTIONS = 20;
