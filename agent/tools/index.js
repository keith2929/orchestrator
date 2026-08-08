// agent/tools/index.js — the tool registry.
//
// Adding a tool = create a module in this folder exporting
// { name, description, parameters, run(args, ctx) } and add it to `toolList`.
import readFile from './readFile.js';
import writeFile from './writeFile.js';
import appendFile from './appendFile.js';
import mkdir from './mkdir.js';
import listDir from './listDir.js';
import glob from './glob.js';
import grep from './grep.js';
import runBash from './runBash.js';
import taskComplete from './taskComplete.js';

// The agent's tool set. Filesystem read/write/search + shell + completion.
export const toolList = [
  readFile,
  writeFile,
  appendFile,
  mkdir,
  listDir,
  glob,
  grep,
  runBash,
  taskComplete,
];

// name -> module, for the tool runner.
export const tools = Object.fromEntries(toolList.map((t) => [t.name, t]));

// Tool definitions in OpenAI function-tool schema, for client.chat({ tools }).
export function toolSchemas() {
  return toolList.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
