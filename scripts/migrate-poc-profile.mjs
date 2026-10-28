import { readFile, writeFile } from 'node:fs/promises';
import { mockPatch } from './mock-config.mjs';
const target = new URL('../.state/windows-home/profiles/desktop/cordis.patch.yml', import.meta.url);
const text = await readFile(target, 'utf8');
const prefix = '# POC-owned local mock provider; no real credentials\n';
const port = text.match(/baseURL: http:\/\/127\.0\.0\.1:(\d+)\/v1/)?.[1];
const expected = port ? prefix + mockPatch(Number(port)).replace('- id: tool-bash\n  disabled: false\n', '') : undefined;
if (text === expected) {
  await writeFile(new URL('../.state/legacy-mock-profile-backup.yml', import.meta.url), text, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await writeFile(target, '# POC isolated profile; real model settings are configured by the user.\n[]\n');
  console.log('Removed only the unchanged legacy mock configuration; backup retained.');
} else console.log('Existing profile preserved; it does not match the legacy generated mock.');
