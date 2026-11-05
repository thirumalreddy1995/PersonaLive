import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonaAttributes, coverage, parseCsv, parsePromptAttributes, selectPersonas } from './personaSet.ts';

test('parsePromptAttributes reads gender, ethnicity, age, skin tone, facial hair, glasses and hairline', () => {
  const a = parsePromptAttributes('A photo of a South Asian man in his 40s with a thick beard and glasses, receding hairline, neutral expression');
  assert.deepEqual(a, { gender: 'man', ethnicity: 'South Asian', age: '40s', skinTone: 'medium', facialHair: 'beard', glasses: true, hairline: 'receding' });

  const b = parsePromptAttributes('Portrait of a young Black woman in her 20s with bangs, studio light');
  assert.deepEqual(b, { gender: 'woman', ethnicity: 'Black', age: '20s', skinTone: 'dark', facialHair: 'clean-shaven', glasses: false, hairline: 'fringe' });

  const c = parsePromptAttributes('an elderly white man with a moustache, no glasses, short grey hair');
  assert.equal(c.gender, 'man');
  assert.equal(c.ethnicity, 'White');
  assert.equal(c.age, '60s');
  assert.equal(c.skinTone, 'light');
  assert.equal(c.facialHair, 'moustache');
  assert.equal(c.glasses, false);
  assert.equal(c.hairline, 'normal');

  const d = parsePromptAttributes('a 35-year-old clean-shaven Indian man with dark skin');
  assert.equal(d.age, '30s');
  assert.equal(d.facialHair, 'clean-shaven');
  assert.equal(d.skinTone, 'dark');
  assert.equal(parsePromptAttributes('a smiling child').age, 'minor');
});

function attrs(over: Partial<PersonaAttributes>): PersonaAttributes {
  return { gender: 'man', ethnicity: 'White', age: '30s', skinTone: 'light', facialHair: 'clean-shaven', glasses: false, hairline: 'normal', ...over };
}

test('coverage lists every missing requirement of the plan', () => {
  const c = coverage([{ attributes: attrs({}), degradedOf: null }]);
  assert.equal(c.total, 1);
  assert.ok(c.missing.includes('South Asian faces: 0/8'));
  assert.ok(c.missing.includes('dark skin tone'));
  assert.ok(c.missing.includes('women'));
  assert.ok(c.missing.includes('glasses'));
  assert.ok(c.missing.includes('receding hairline'));
  assert.ok(c.missing.includes('fringe over the forehead'));
  assert.ok(c.missing.includes('beard'));
  assert.ok(c.missing.includes('age 60s'));
  // Degraded copies do not count toward coverage.
  const d = coverage([{ attributes: attrs({}), degradedOf: null }, { attributes: attrs({ gender: 'woman' }), degradedOf: 'p01' }]);
  assert.ok(d.missing.includes('women'));
});

test('selectPersonas fills every required slot from a mixed pool and tops up to the target', () => {
  const pool: Array<{ id: number; attributes: PersonaAttributes }> = [];
  let id = 0;
  const genders: PersonaAttributes['gender'][] = ['man', 'woman'];
  const tones: Array<[string, PersonaAttributes['skinTone']]> = [['South Asian', 'medium'], ['Black', 'dark'], ['White', 'light'], ['East Asian', 'light'], ['South Asian', 'dark']];
  const ages = ['20s', '30s', '40s', '50s', '60s'];
  const hair: PersonaAttributes['facialHair'][] = ['beard', 'moustache', 'clean-shaven'];
  const lines: PersonaAttributes['hairline'][] = ['normal', 'receding', 'fringe'];
  for (const gender of genders)
    for (const [ethnicity, skinTone] of tones)
      for (const age of ages)
        for (const facialHair of hair)
          for (const hairline of lines)
            pool.push({ id: id++, attributes: { gender, ethnicity, age, skinTone, facialHair: gender === 'woman' ? 'clean-shaven' : facialHair, glasses: id % 4 === 0, hairline } });
  // Filler that would crowd out the rare attributes if selection were naive.
  for (let i = 0; i < 200; i++) pool.unshift({ id: id++, attributes: attrs({}) });

  const chosen = selectPersonas(pool, 24);
  assert.equal(chosen.length, 24);
  assert.equal(new Set(chosen).size, 24);
  const c = coverage(chosen.map((p) => ({ attributes: p.attributes, degradedOf: null })));
  assert.deepEqual(c.missing, []);
  assert.ok(c.southAsian >= 8);
});

test('parseCsv handles quoted commas, doubled quotes and CRLF', () => {
  const rows = parseCsv('image_filename,text_prompt,model\r\n"a.jpg","a man, 40s, ""neutral""",Flux1.dev\r\nb.jpg,plain prompt,SDXL\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text_prompt, 'a man, 40s, "neutral"');
  assert.equal(rows[0].model, 'Flux1.dev');
  assert.equal(rows[1].image_filename, 'b.jpg');
});
