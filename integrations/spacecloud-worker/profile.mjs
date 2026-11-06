import { mkdir, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function acquireProfileLock(profile) {
  if(typeof profile!=='string' || !profile.trim())throw new Error('A dedicated browser profile directory is required.');
  const profileDir=resolve(profile),lockDir=resolve(profileDir,'.worker-lock');
  await mkdir(profileDir,{recursive:true,mode:0o700});
  try {await mkdir(lockDir,{mode:0o700});}
  catch {throw new Error('Cannot lock the dedicated browser profile. Check directory permissions or another running worker.');}
  return {profileDir,lockDir,release:()=>rmdir(lockDir)};
}
