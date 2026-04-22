import { FortigateSession } from '../connection/session';
import { ConfigBlock, Document, findBlock } from '../parser';
import { StagedChanges } from '../staging/stagedChanges';
import { Logger } from '../util/logger';
import { ChangeScript, build, compareForVerify } from './diffEngine';

export class ApplyMismatchError extends Error {
  constructor(public readonly mismatches: string[]) {
    super(
      `Read-back verification failed. The device did not end up in the expected state:\n` +
        mismatches.map((m) => `  - ${m}`).join('\n'),
    );
  }
}

export interface ApplyResult {
  commandsSent: number;
  pathsVerified: string[];
}

/**
 * Apply staged changes end-to-end:
 *   1. Build the minimal CLI script from pristine vs staged-composed.
 *   2. Run each change group as its own `config ... end` transaction.
 *   3. For every touched top-level path, `show <path>`, re-parse, and compare
 *      against what we expected. Only a full structural match counts as success.
 *   4. On success, refresh pristine and clear staging. On mismatch, leave the
 *      staged state intact so the user can re-apply or discard.
 */
export async function applyChanges(
  session: FortigateSession,
  staged: StagedChanges,
  logger: Logger,
): Promise<ApplyResult> {
  const pristine = session.cachedDocument();
  if (!pristine) {
    throw new Error('Cannot apply: configuration has not been loaded yet.');
  }
  const composed = staged.compose(pristine);
  const script: ChangeScript = build(pristine, composed);
  if (script.isEmpty()) {
    return { commandsSent: 0, pathsVerified: [] };
  }

  logger.info(`Applying ${script.groups.length} change group(s)`);
  let totalCommands = 0;
  for (const group of script.groups) {
    logger.debug(`-> config ${group.path.join(' ')}`);
    for (const c of group.commands) logger.debug(`   ${c}`);
    await session.runScript(group.commands);
    totalCommands += group.commands.length;
  }

  // Read-back verification
  const verifiedPaths: string[] = [];
  const mismatches: string[] = [];
  for (const path of script.touchedPaths()) {
    const doc: Document = await session.showPath(path);
    const actual: ConfigBlock | undefined = findBlock(doc, path);
    const expected: ConfigBlock | undefined = findBlock(composed, path);
    if (!expected) {
      if (actual) {
        mismatches.push(`${path.join(' ')}: block expected to be absent but is present on device`);
      }
      continue;
    }
    mismatches.push(...compareForVerify(path, expected, actual));
    verifiedPaths.push(path.join(' '));
  }

  if (mismatches.length > 0) {
    throw new ApplyMismatchError(mismatches);
  }

  // Refresh pristine snapshot and clear staging.
  await session.showAll();
  staged.clear();

  return { commandsSent: totalCommands, pathsVerified: verifiedPaths };
}
