import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireProfileLock } from '../profile.mjs';

test('profile lock writes only inside the persistent volume and refuses a second worker',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'spacecloud-profile-test-'));
  try {
    const profile=join(dir,'persistent-volume','profile'),lock=await acquireProfileLock(profile);
    assert.equal(lock.profileDir,profile);assert.equal(lock.lockDir,join(profile,'.worker-lock'));
    assert.equal((await stat(lock.lockDir)).isDirectory(),true);
    assert.equal((await stat(profile)).mode&0o777,0o700);
    await assert.rejects(acquireProfileLock(profile),/Cannot lock/);
    await lock.release();
    const restarted=await acquireProfileLock(profile);await restarted.release();
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('Docker and login override retain the same writable profile volume with no published port',async()=>{
  const compose=await readFile(new URL('../compose.yaml',import.meta.url),'utf8');
  const login=await readFile(new URL('../compose.login.yaml',import.meta.url),'utf8');
  const dockerfile=await readFile(new URL('../Dockerfile',import.meta.url),'utf8');
  assert.match(compose,/SPACECLOUD_PROFILE_DIR: \/var\/lib\/spacecloud-profile/);
  assert.match(compose,/spacecloud-profile:\/var\/lib\/spacecloud-profile/);
  assert.match(compose,/read_only: true/);assert.doesNotMatch(compose,/\n\s*ports:/);
  assert.doesNotMatch(login,/SPACECLOUD_PROFILE_DIR|\n\s*ports:/);
  assert.match(dockerfile,/USER pwuser/);
  assert.match(dockerfile,/chmod 700 \/var\/lib\/spacecloud-profile/);
});
