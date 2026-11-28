#!/usr/bin/env node

import { lstat, realpath } from 'node:fs/promises';
import { constants, openSync, closeSync, fstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readManualMissionReview, recordManualMissionReview } from './manual-mission-review.js';
import { installServiceHistory } from '../../persistence/service-history.js';

async function withPrivateDatabase(file: any, { readOnly }: any, review: any) {
  const path = resolve(file);
  const directory = dirname(path);
  const uid = process.getuid!();
  const privateOwned = (info: any, type: any) => info[type]() && info.uid === uid && !(info.mode & 0o077);
  if (await realpath(directory) !== directory || !privateOwned(await lstat(directory), 'isDirectory')) {
    throw new Error('Review database must be in a canonical owner-private directory');
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const info = await lstat(path + suffix).catch((error: any) => { if (error.code !== 'ENOENT') throw error; });
    if (info && !privateOwned(info, 'isFile')) throw new Error('Review database sidecar must be an owner-private file');
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (info.nlink !== 1 || !privateOwned(info, 'isFile')) throw new Error('Review database must be an owner-private regular file');
    const database = new DatabaseSync(path, { readOnly });
    try {
      const actual = await lstat(path);
      if (actual.dev !== info.dev || actual.ino !== info.ino) throw new Error('Review database changed during open');
      database.exec('PRAGMA busy_timeout = 2500');
      // A different process owns this connection. Install transaction tracking
      // here too, so its decision becomes visible at its committed boundary.
      if (!readOnly) installServiceHistory(database, { domain: 'task' });
      return review(database);
    } finally {
      database.close();
    }
  } finally {
    closeSync(fd);
  }
}

try {
  const [command, file, missionId, submissionId, fingerprint, verdict, requestId, reason, ...extra] = process.argv.slice(2);
  const inspect = command === 'show';
  if (!file || !missionId || !submissionId || extra.length || (inspect ? fingerprint !== undefined : command !== 'decide' || !reason)) {
    throw new Error('Usage: review-mission.mjs show DB MISSION SUBMISSION\n       review-mission.mjs decide DB MISSION SUBMISSION FINGERPRINT PASS|FAIL REQUEST_ID "REASON"');
  }
  const result = await withPrivateDatabase(file, { readOnly: inspect }, (database: any) => inspect
    ? readManualMissionReview(database, missionId, submissionId)
    : recordManualMissionReview(database, { missionId, submissionId, fingerprint, verdict, requestId, reason }));
  console.log(JSON.stringify(result, null, 2));
} catch (error: any) {
  console.error(error.code ? `${error.code} ${error.message}` : error.message);
  process.exitCode = 1;
}
