import { hasConfiguredDoorbell, isLegacyOptions, migrateOptions, parseOptions, readOptions, type AddonConfig } from './config.ts';
import type { Logger } from './log.ts';
import { saveOptions, storedOptions, underSupervisor } from './supervisor.ts';

/**
 * Read the options. Versions before 0.6 had flat options, and the Supervisor drops keys the new
 * schema doesn't know from options.json. In that case fetch the stored ones, convert them and
 * save them back, so the Configuration tab shows them in the new format.
 */
export async function loadAddonConfig(log: Logger, env: NodeJS.ProcessEnv = process.env, path?: string): Promise<AddonConfig> {
  let raw = readOptions(path);
  if (!hasConfiguredDoorbell(raw) && underSupervisor(env)) {
    try {
      const stored = await storedOptions(env);
      if (isLegacyOptions(stored)) {
        raw = migrateOptions(stored);
        try {
          await saveOptions(raw, env);
          log.info('converted your options to the new format (Doorbells list and sections); review them on the Configuration tab');
        } catch (err) {
          log.warn(`using your previous options, but could not save them in the new format: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      log.debug(`no stored options to convert: ${(err as Error).message}`);
    }
  }
  return parseOptions(raw, env);
}
