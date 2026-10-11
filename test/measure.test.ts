import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChild } from '../scripts/measure.js';

describe('classifyChild', () => {
  it('classifies a non-zero exit with a Run ID as completed', () => {
    assert.equal(
      classifyChild({
        status: 1,
        signal: null,
        error: undefined,
        stdout: 'Run ID: run-12345',
        stderr: '',
        timedOut: false,
      }),
      'completed'
    );
  });

  it('classifies a 429 response without a Run ID as transient', () => {
    assert.equal(
      classifyChild({
        status: 1,
        signal: null,
        error: undefined,
        stdout: '',
        stderr: 'HTTP 429 rate limit exceeded',
        timedOut: false,
      }),
      'transient'
    );
  });

  it('classifies an unrecognized failure without a Run ID as crashed', () => {
    assert.equal(
      classifyChild({
        status: 1,
        signal: null,
        error: undefined,
        stdout: '',
        stderr: 'unexpected process failure',
        timedOut: false,
      }),
      'crashed'
    );
  });

  it('classifies a timed-out child as timed_out', () => {
    assert.equal(
      classifyChild({
        status: null,
        signal: 'SIGTERM',
        error: new Error('spawnSync ETIMEDOUT'),
        stdout: '',
        stderr: '',
        timedOut: true,
      }),
      'timed_out'
    );
  });
});
