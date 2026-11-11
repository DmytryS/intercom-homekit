/** Entry point for the npm version hooks in package.json; the steps are in versioning.ts. */
import { apply, check, commit } from './versioning.ts';

const steps: Record<string, () => void> = { check, apply, commit };
const step = steps[process.argv[2] ?? ''];
if (!step) {
  console.error(`unknown step "${process.argv[2]}" (check, apply or commit)`);
  process.exit(1);
}
step();
