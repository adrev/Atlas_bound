import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const mock = fileURLToPath(new URL('./fixtures/deploy-gcloud.cjs', import.meta.url));

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-deploy-cli-'));
  const before = {
    metadata: { name: 'test-service', annotations: {} },
    spec: {
      template: {
        metadata: {
          name: 'old-revision',
          annotations: { 'autoscaling.knative.dev/maxScale': '7' },
        },
        spec: {
          serviceAccountName: 'preserved@example.test',
          timeoutSeconds: 3600,
          containers: [
            {
              image: 'old-image',
              resources: { limits: { cpu: '2', memory: '2Gi' } },
              env: [
                { name: 'PGPASSWORD', valueFrom: { secretKeyRef: { name: 'db', key: '9' } } },
                { name: 'UNKNOWN', value: 'keep' },
                { name: 'REMOVE_ME', value: 'remove' },
              ],
            },
          ],
        },
      },
    },
    status: {
      latestCreatedRevisionName: 'old-revision',
      traffic: [{ revisionName: 'old-revision', percent: 100 }],
    },
  };
  await writeFile(join(dir, 'before.json'), JSON.stringify(before));
  await writeFile(join(dir, 'gcloud'), '#!/bin/sh\nexec "$MOCK_NODE" "$MOCK_GCLOUD" "$@"\n', {
    mode: 0o700,
  });
  const env = {
    ...process.env,
    PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`,
    MOCK_NODE: process.execPath,
    MOCK_GCLOUD: mock,
    MOCK_BEFORE: join(dir, 'before.json'),
    MOCK_STATE: join(dir, 'state.json'),
    MOCK_LOG: join(dir, 'calls.jsonl'),
    GCP_PROJECT_ID: 'test-project',
    GCP_REGION: 'test-region',
    CLOUD_RUN_SERVICE: 'test-service',
    PGPASSWORD: 'stale-shell-secret-must-not-rotate',
    BASE_URL: 'http://localhost:3000',
  };
  return {
    dir,
    env,
    before,
    calls: async () =>
      (await readFile(env.MOCK_LOG, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
  };
}

describe('deploy.sh mock CLI end-to-end', () => {
  it.each([false, true])(
    'retains config and traffic with explicit env updates=%s',
    async (update) => {
      const f = await fixture();
      try {
        const args = [join(root, 'deploy.sh'), '--image', 'test-image'];
        if (update) {
          const path = join(f.dir, 'updates.json');
          await writeFile(
            path,
            JSON.stringify({
              UNKNOWN: 'new,value=with\nsyntax',
              PGPASSWORD: { secret: 'db-next', version: '10' },
              REMOVE_ME: null,
            })
          );
          args.push('--env-updates', path);
        }
        const result = await exec('/bin/bash', args, { cwd: root, env: f.env });
        expect(result.stdout).toContain('configuration verified and existing traffic retained');
        expect(result.stdout).not.toContain('stale-shell-secret');
        const calls = await f.calls();
        expect(calls.map((call) => call.operation)).toEqual([
          'describe',
          'describe',
          'deploy',
          'describe',
        ]);
        const deploy = calls[2];
        expect(deploy.args).toContain('--no-traffic');
        if (update)
          expect(deploy.flags).toEqual({
            '--update-env-vars': { UNKNOWN: 'new,value=with\nsyntax' },
            '--update-secrets': { PGPASSWORD: 'db-next:10' },
            '--remove-env-vars': ['REMOVE_ME'],
          });
        else expect(deploy.flags).toEqual({});
        for (const forbidden of [
          '--memory',
          '--cpu',
          '--max-instances',
          '--env-vars-file',
          '--allow-unauthenticated',
        ])
          expect(deploy.args).not.toContain(forbidden);
        const state = JSON.parse(await readFile(f.env.MOCK_STATE, 'utf8'));
        expect(state.after.status.traffic).toEqual(f.before.status.traffic);
        expect(state.after.spec.template.spec.containers[0].resources).toEqual(
          f.before.spec.template.spec.containers[0].resources
        );
      } finally {
        await rm(f.dir, { recursive: true, force: true });
      }
    }
  );

  it('aborts before deploy if another same-config candidate changed image/revision', async () => {
    const f = await fixture();
    try {
      await expect(
        exec('/bin/bash', [join(root, 'deploy.sh'), '--image', 'test-image'], {
          cwd: root,
          env: { ...f.env, MOCK_CONCURRENT: '1' },
        })
      ).rejects.toThrow('Candidate image/revision changed');
      expect((await f.calls()).map((call) => call.operation)).toEqual(['describe', 'describe']);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
});
