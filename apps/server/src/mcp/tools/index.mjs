import { registerWhoami } from './whoami.mjs';
import { registerTables } from './tables.mjs';
import { registerRows } from './rows.mjs';
import { registerFunctions } from './functions.mjs';
import { registerStorage } from './storage.mjs';

export function registerTools(deps) {
  registerWhoami(deps);
  registerTables(deps);
  registerRows(deps);
  registerFunctions(deps);
  registerStorage(deps);
}
