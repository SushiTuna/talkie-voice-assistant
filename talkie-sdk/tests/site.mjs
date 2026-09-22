/**
 * Tests for the site build pipeline and pure modules.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

/* ------------------------------------------------------------------- snippet */

{
  const { buildSnippet } = await import('../site/src/snippet.js');

  // Default config: only api emitted.
  const defaultHtml = buildSnippet({});
  check(
    'default config emits talkie-assistant with api only',
    defaultHtml.split('\n')[1].trim() === '<talkie-assistant api="http://localhost:8000"></talkie-assistant>',
  );

  // mode emitted only when non-default.
  let html = buildSnippet({ attrs: { mode: 'push-to-talk' } });
  check(
    'mode="push-to-talk" is emitted',
    html.includes('mode="push-to-talk"'),
  );
  html = buildSnippet({ attrs: {} }); // back to defaults
  check(
    'default mode is not emitted',
    !html.includes('mode='),
  );

  // layout emitted only when non-default.
  html = buildSnippet({ attrs: { layout: 'sheet' } });
  check(
    'layout="sheet" is emitted',
    html.includes('layout="sheet"'),
  );
  check(
    'default layout is not emitted',
    !buildSnippet({}).includes('layout='),
  );

  // barge-in: 'off' emitted, 'on' omitted.
  html = buildSnippet({ attrs: { 'barge-in': 'off' } });
  check(
    'barge-in="off" is emitted',
    html.includes('barge-in="off"'),
  );
  check(
    'barge-in="on" (default) is not emitted',
    !buildSnippet({}).includes('barge-in'),
  );

  // HTML escaping for special characters.
  html = buildSnippet({ attrs: { profile: '&"<>test' } });
  check(
    'special characters in attribute values are escaped',
    html.includes('&amp;&quot;&lt;&gt;test'),
  );

  // Theme styling.
  html = buildSnippet({
    theme: { '--talkie-ink': '#111', '--talkie-paper': '#fff', color: 'red' },
  });
  const line2 = html.split('\n')[1];
  check(
    'theme variables starting with --talkie- become the style attribute',
    line2.includes('style="--talkie-ink: #111; --talkie-paper: #fff"'),
  );
  check(
    'non--talkie- keys are dropped from theme',
    !line2.includes('color:red'),
  );

  // Theme with different values (verifies computed themeAttrs, not hard-coded fallback).
  html = buildSnippet({
    theme: { '--talkie-ink': '#abcdef', '--talkie-wave-color': '#123456' },
  });
  const line2b = html.split('\n')[1];
  check(
    'custom theme colors are rendered',
    line2b.includes('style="--talkie-ink: #abcdef; --talkie-wave-color: #123456"'),
  );
}

/* ------------------------------------------------------------------- profile */

{
  const { validateTools, toAgentContext, fromAgentContext } =
    await import('../site/src/profile.js');

  // Empty / whitespace-only → ok true, tools [].
  check(
    'validateTools accepts empty string',
    JSON.stringify(validateTools('')) === '{"ok":true,"tools":[]}',
  );
  check(
    'validateTools accepts whitespace-only string',
    JSON.stringify(validateTools('  \n\t  ')) === '{"ok":true,"tools":[]}',
  );

  // Bad JSON.
  const badJson = validateTools('{bad');
  check(
    'validateTools rejects invalid JSON',
    badJson.ok === false,
    String(badJson.error),
  );

  // Not an array.
  const notArray = validateTools('{"foo":"bar"}');
  check(
    'validateTools rejects object (not array)',
    notArray.ok === false,
    String(notArray.error),
  );

  // Missing description with item numbering.
  const missingDesc = validateTools('[{"type":"function","name":"foo"}]');
  check(
    'validateTools reports missing description with item index',
    missingDesc.ok === false && missingDesc.error.includes('Tool 1') && missingDesc.error.includes('description'),
    missingDesc.error,
  );

  // Valid tool definition.
  const validResult = validateTools('[{"type":"function","name":"hello","description":"says hello","parameters":{}}]');
  check(
    'validateTools accepts a valid tool',
    validResult.ok === true && Array.isArray(validResult.tools) && validResult.tools.length === 1,
  );

  const dup = validateTools('[{"type":"function","name":"a","description":"d","parameters":{}},{"type":"function","name":"a","description":"d","parameters":{}}]');
  check('validateTools rejects duplicate tool names, as the server does', dup.ok === false && dup.error.includes('duplicate'), dup.error);

  // Null array item.
  const nullItem = validateTools('[null]');
  check(
    'validateTools rejects null array item',
    nullItem.ok === false && nullItem.error === 'Tool 1: must be an object',
    nullItem.error,
  );

  /* toAgentContext */
  const ctx = toAgentContext({
    name: 'AI Assistant',
    description: 'An AI assistant',
    systemPrompt: 'You are helpful.',
    keyterms: 'helpful, clever,\ncreative',
  });
  check(
    'toAgentContext slugifies name and includes required fields',
    ctx.profile === 'ai-assistant' && ctx.system_prompt === 'You are helpful.',
  );
  check(
    'toAgentContext splits keyterms and omits empty optionals',
    Array.isArray(ctx.keyterms) && ctx.keyterms.length === 3 && !ctx.greeting,
  );

  /* fromAgentContext */
  const json = { profile: 'my-agent', system_prompt: 'Be concise.', description: 'A bot' };
  const form = fromAgentContext(json);
  check(
    'fromAgentContext round-trips name from profile',
    form.name === 'my-agent',
  );
  check(
    'fromAgentContext preserves system_prompt',
    form.systemPrompt === 'Be concise.',
  );

  // Throws when missing system_prompt.
  let threw = false;
  try { fromAgentContext({ profile: 'x' }); } catch { threw = true; }
  check(
    'fromAgentContext throws on missing system_prompt',
    threw,
  );
}

/* ------------------------------------------------------------------- server profile files */

{
  const { toServerProfile, fromServerProfile, serverProfileProblems } = await import('../site/src/profile.js');
  const form = { name: 'Tour Guide', description: 'd', systemPrompt: 'Be brief.', voice: 'anna', greeting: 'Hi!', keyterms: 'Talkie,\n  lobby ' };
  const file = toServerProfile(form);
  check('toServerProfile puts the prompt in system_prompt_override',
    file.system_prompt_override === 'Be brief.' && !('system_prompt' in file) && !('profile' in file));
  check('toServerProfile keeps greeting, voice, description and split keyterms',
    file.greeting === 'Hi!' && file.voice === 'anna' && file.description === 'd' && JSON.stringify(file.keyterms) === '["Talkie","lobby"]');
  check('toServerProfile omits empty optionals', !('voice' in toServerProfile({ systemPrompt: 'x', greeting: 'y' })));

  const back = fromServerProfile(file, 'tour-guide');
  check('fromServerProfile round-trips a console profile',
    back.name === 'tour-guide' && back.systemPrompt === 'Be brief.' && back.keyterms === 'Talkie, lobby' && back.greeting === 'Hi!');
  let threw = false;
  try { fromServerProfile({ agent: { role: 'x' }, greeting: 'Hi' }, 'property'); } catch { threw = true; }
  check('fromServerProfile refuses profiles built from agent sections', threw);

  const toolJson = '[{"type":"function","name":"go_to_room","description":"Go.","parameters":{"type":"object"}}]';
  const withTools = toServerProfile({ ...form, tools: toolJson });
  check('toServerProfile sends tools as parsed JSON', Array.isArray(withTools.tools) && withTools.tools[0].name === 'go_to_room');
  check('...and fromServerProfile brings them back as editable JSON',
    JSON.parse(fromServerProfile(withTools, 'x').tools)[0].name === 'go_to_room');
  check('toServerProfile omits an empty tools list', !('tools' in toServerProfile({ ...form, tools: '  ' })));
  const badTools = serverProfileProblems({ ...form, tools: '{"not":"an array"}' });
  check('serverProfileProblems refuses invalid tools rather than dropping them', badTools.some((p) => p.includes('tools')), badTools.join(' | '));

  check('serverProfileProblems is empty for a complete profile', serverProfileProblems(form).length === 0);
  const problems = serverProfileProblems({ name: '!!', systemPrompt: ' ', greeting: '' });
  check('serverProfileProblems names the missing name, prompt and greeting', problems.length === 3, problems.join(' | '));
}

/* ------------------------------------------------------------------- talkie-assistant source */

{
  const src = readFileSync(join(ROOT, 'src', 'components', 'talkie-assistant.js'), 'utf8');
  check(
    'talkie-assistant source still contains _createBackend(options)',
    src.includes('_createBackend(options)'),
  );
}

/* ------------------------------------------------------------------- page markup */

{
  const page = (name) => readFileSync(join(ROOT, 'site', name), 'utf8');

  // lion-tabs overwrites panel ids with its own, so docs.js finds panels by data-doc.
  const docs = page('docs.html');
  const docsJs = readFileSync(join(ROOT, 'site', 'src', 'pages', 'docs.js'), 'utf8');
  for (const id of ['guide', 'integration', 'checklist']) {
    check(`docs.html has a data-doc="${id}" panel`, docs.includes(`data-doc="${id}"`));
    check(`docs.js knows doc id "${id}"`, docsJs.includes(`id: '${id}'`));
  }
  check('docs.html panels carry no ids for lion-tabs to overwrite', !/slot="panel"[^>]*\sid=/.test(docs));

  // <lion-form> must wrap the native <form>, not the other way round.
  const consoleHtml = page('console.html');
  check('console.html: lion-form wraps the native form', /<lion-form id="profile-form">\s*<form>/.test(consoleHtml));
  check('console.html: no native form around lion-form', !/<form>\s*<lion-form/.test(consoleHtml));

  // Home page: the token-route pointer is a link into the docs, not literal markdown.
  const home = page('index.html');
  check('index.html has no literal markdown emphasis', !/\*The token route\*/.test(home));
  check('index.html links the token route into the docs', home.includes('docs.html#guide/'));
}

/* ------------------------------------------------------------------- build-site */

{
  // A stale chunk from an earlier build must not survive the next one.
  const stale = join(ROOT, 'site', 'dist', 'chunk-STALE0000.js');
  writeFileSync(stale, '// stale');
  execFileSync(process.execPath, [join(ROOT, 'build-site.mjs')], { stdio: 'pipe' });

  const distDir = join(ROOT, 'site', 'dist');
  const files = readdirSync(distDir);

  for (const name of ['home.js', 'playground.js', 'console.js', 'docs.js']) {
    check(`build produces site/dist/${name}`, files.includes(name), files.join(', '));
  }
  check('build clears stale files from site/dist', !files.includes('chunk-STALE0000.js'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
