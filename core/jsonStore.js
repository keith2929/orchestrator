// Atomic JSON file persistence. Every writer in the app should go through
// writeJson so a kill mid-write (./stop.sh, OOM, VM pause) never truncates a
// state file: we write to a .tmp sibling and rename over the target, which is
// atomic on the same filesystem. A copy of the previous good file is kept as
// .prev so readJson can recover from a corrupt/truncated file.
import fs from 'node:fs';

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    try {
      const recovered = JSON.parse(fs.readFileSync(`${file}.prev`, 'utf8'));
      console.warn(`[jsonStore] recovered ${file} from .prev`);
      return recovered;
    } catch {
      return fallback;
    }
  }
}

export function writeJson(file, data) {
  const json = JSON.stringify(data, null, 2);
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.prev`);
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, file);
}

// Plain read, no .prev fallback — used by getStateDir(), which must not recurse.
export function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
