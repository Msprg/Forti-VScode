import * as assert from 'assert';
import { parse } from '../../src/parser';
import { build, compareForVerify } from '../../src/commit/diffEngine';
import { findBlockInDoc } from '../../src/fs/uri';

function diff(pristineText: string, stagedText: string): string[] {
  const p = parse(pristineText);
  const s = parse(stagedText);
  const script = build(p, s);
  return script.allCommands();
}

describe('diff engine', () => {
  it('emits nothing when trees are identical', () => {
    const text = `config system global
    set hostname "fgt"
end
`;
    assert.deepStrictEqual(diff(text, text), []);
  });

  it('emits a single set for a changed value', () => {
    const p = `config system global
    set hostname "fgt"
end
`;
    const s = `config system global
    set hostname "fgt-new"
end
`;
    assert.deepStrictEqual(diff(p, s), [
      'config system global',
      '    set hostname "fgt-new"',
      'end',
    ]);
  });

  it('emits unset for a removed setting', () => {
    const p = `config system global
    set hostname "fgt"
    set admintimeout 60
end
`;
    const s = `config system global
    set hostname "fgt"
end
`;
    assert.deepStrictEqual(diff(p, s), [
      'config system global',
      '    unset admintimeout',
      'end',
    ]);
  });

  it('adds new entry with all its settings', () => {
    const p = `config firewall policy
    edit 1
        set name "a"
    next
end
`;
    const s = `config firewall policy
    edit 1
        set name "a"
    next
    edit 2
        set name "b"
        set action accept
    next
end
`;
    assert.deepStrictEqual(diff(p, s), [
      'config firewall policy',
      '    edit 2',
      '        set name "b"',
      '        set action accept',
      '    next',
      'end',
    ]);
  });

  it('deletes removed entries', () => {
    const p = `config firewall policy
    edit 1
        set name "a"
    next
    edit 2
        set name "b"
    next
end
`;
    const s = `config firewall policy
    edit 1
        set name "a"
    next
end
`;
    assert.deepStrictEqual(diff(p, s), [
      'config firewall policy',
      '    delete 2',
      'end',
    ]);
  });

  it('emits entry-scoped diff for modified entries only', () => {
    const p = `config firewall policy
    edit 1
        set name "a"
        set action accept
    next
    edit 2
        set name "b"
    next
end
`;
    const s = `config firewall policy
    edit 1
        set name "a"
        set action deny
    next
    edit 2
        set name "b"
    next
end
`;
    assert.deepStrictEqual(diff(p, s), [
      'config firewall policy',
      '    edit 1',
      '        set action deny',
      '    next',
      'end',
    ]);
  });

  it('compareForVerify returns no mismatches for a valid apply', () => {
    const expected = parse(`config firewall policy
    edit 1
        set name "a"
    next
end
`);
    const actual = parse(`config firewall policy
    edit 1
        set name "a"
        set action accept
    next
end
`);
    const expBlock = findBlockInDoc(expected, ['firewall', 'policy'])!;
    const actBlock = findBlockInDoc(actual, ['firewall', 'policy'])!;
    // Extra setting in actual is okay (could be a device default). Extra entry would not be.
    const mismatches = compareForVerify(['firewall', 'policy'], expBlock, actBlock);
    assert.deepStrictEqual(mismatches, []);
  });

  it('compareForVerify flags extra entries and missing values', () => {
    const expected = parse(`config firewall policy
    edit 1
        set name "a"
    next
end
`);
    const actual = parse(`config firewall policy
    edit 1
        set name "wrong"
    next
    edit 99
        set name "ghost"
    next
end
`);
    const mismatches = compareForVerify(
      ['firewall', 'policy'],
      findBlockInDoc(expected, ['firewall', 'policy'])!,
      findBlockInDoc(actual, ['firewall', 'policy'])!,
    );
    assert.strictEqual(
      mismatches.some((m) => m.includes('edit 99')),
      true,
    );
    assert.strictEqual(
      mismatches.some((m) => m.includes('set name')),
      true,
    );
  });
});
