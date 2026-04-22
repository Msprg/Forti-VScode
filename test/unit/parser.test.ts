import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parse, serialize, ConfigBlock } from '../../src/parser';

const FIXTURES = path.resolve(__dirname, '..', 'fixtures');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

/**
 * Round-trip a fixture through parse -> serialize -> parse and assert the AST
 * is structurally identical. We don't compare raw text byte-for-byte because
 * the serializer canonicalises quoting.
 */
function assertRoundTrip(fixtureName: string) {
  const source = loadFixture(fixtureName);
  const doc1 = parse(source);
  const text = serialize(doc1);
  const doc2 = parse(text);
  assert.deepStrictEqual(stripMaps(doc1), stripMaps(doc2), `roundtrip mismatch for ${fixtureName}`);
}

function stripMaps(value: any): any {
  if (value instanceof Map) {
    return Array.from(value.entries()).map(([k, v]) => [k, stripMaps(v)]);
  }
  if (Array.isArray(value)) return value.map(stripMaps);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripMaps(v);
    return out;
  }
  return value;
}

describe('FortiGate parser', () => {
  it('parses a singleton config block (system global)', () => {
    const doc = parse(loadFixture('system-global.conf'));
    assert.strictEqual(doc.blocks.length, 1);
    const block = doc.blocks[0];
    assert.deepStrictEqual(block.path, ['system', 'global']);
    assert.strictEqual(block.entries.size, 0);
    assert.strictEqual(block.settings.get('hostname')?.values[0], 'fgt-lab');
    assert.strictEqual(block.settings.get('admintimeout')?.values[0], '60');
  });

  it('parses a table block with multiple entries', () => {
    const doc = parse(loadFixture('firewall-policy.conf'));
    assert.strictEqual(doc.blocks.length, 1);
    const block = doc.blocks[0];
    assert.strictEqual(block.entries.size, 2);
    const p1 = block.entries.get('1')!;
    assert.strictEqual(p1.name, '1');
    assert.deepStrictEqual(p1.settings.get('service')!.values, ['HTTPS', 'HTTP']);
    assert.strictEqual(p1.settings.get('name')!.values[0], 'allow-out');
    const p2 = block.entries.get('2')!;
    assert.strictEqual(p2.settings.get('action')!.values[0], 'deny');
  });

  it('parses multi-token values and escaped quotes', () => {
    const doc = parse(loadFixture('system-interface.conf'));
    const block = doc.blocks[0] as ConfigBlock;
    const port1 = block.entries.get('port1')!;
    assert.deepStrictEqual(port1.settings.get('ip')!.values, [
      '192.168.1.99',
      '255.255.255.0',
    ]);
    assert.deepStrictEqual(port1.settings.get('allowaccess')!.values, [
      'ping',
      'https',
      'ssh',
      'http',
    ]);
    const wan1 = block.entries.get('wan1')!;
    assert.strictEqual(
      wan1.settings.get('description')!.values[0],
      'uplink with spaces and "quotes"',
    );
  });

  it('round-trips all fixtures', () => {
    assertRoundTrip('system-global.conf');
    assertRoundTrip('firewall-policy.conf');
    assertRoundTrip('system-interface.conf');
  });

  it('preserves insertion order of entries and settings', () => {
    const doc = parse(loadFixture('firewall-policy.conf'));
    const block = doc.blocks[0];
    const entryNames = Array.from(block.entries.keys());
    assert.deepStrictEqual(entryNames, ['1', '2']);
    const p1 = block.entries.get('1')!;
    const keys = Array.from(p1.settings.keys());
    assert.deepStrictEqual(keys.slice(0, 3), ['name', 'srcintf', 'dstintf']);
  });

  it('handles nested config inside an edit', () => {
    const src = [
      'config firewall policy',
      '    edit 1',
      '        set name "x"',
      '        config log-custom-field-name',
      '            edit 1',
      '                set name "foo"',
      '                set value "bar"',
      '            next',
      '        end',
      '    next',
      'end',
    ].join('\n');
    const doc = parse(src);
    const block = doc.blocks[0];
    const p1 = block.entries.get('1')!;
    assert.strictEqual(p1.children.length, 1);
    assert.deepStrictEqual(p1.children[0].path, ['log-custom-field-name']);
    assert.strictEqual(p1.children[0].entries.size, 1);
  });
});
