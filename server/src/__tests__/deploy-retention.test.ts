import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const helper = new URL('../../../scripts/deploy-config.mjs', import.meta.url);
const { environmentPlan, configuration, verify, validateUpdates } = await import(helper.href);

function service() {
  return {
    metadata: {
      name: 'atlas-bound',
      annotations: { 'run.googleapis.com/ingress': 'internal', 'run.googleapis.com/minScale': '0' },
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            'autoscaling.knative.dev/minScale': '0',
            'autoscaling.knative.dev/maxScale': '7',
            'run.googleapis.com/cpu-throttling': 'true',
            'run.googleapis.com/cloudsql-instances': 'project:region:db',
            'run.googleapis.com/sessionAffinity': 'true',
          },
        },
        spec: {
          serviceAccountName: 'runtime@example.test',
          timeoutSeconds: 3600,
          containerConcurrency: 64,
          containers: [
            {
              image: 'old-image',
              resources: { limits: { cpu: '2', memory: '2Gi' } },
              ports: [{ containerPort: 8080 }],
              env: [
                { name: 'UNKNOWN_FUTURE_KEY', value: 'private-config-value' },
                { name: 'VERTEX_LOCATION', value: 'europe-west1' },
                { name: 'CHRONICLER_MODEL', value: 'custom-model' },
                { name: 'BASE_URL', value: 'https://custom.example.test' },
                {
                  name: 'PGPASSWORD',
                  valueFrom: { secretKeyRef: { name: 'db-secret', key: '9' } },
                },
              ],
            },
          ],
        },
      },
    },
    status: { traffic: [{ revisionName: 'old-revision', percent: 100, latestRevision: true }] },
  };
}

describe('candidate deployment configuration retention', () => {
  it('retains every unknown key and secret reference without emitting any env mutation flags', () => {
    const before = service();
    const plan = environmentPlan(before);
    expect(plan.flags).toEqual({});
    expect(plan.env).toEqual(configuration(before).spec.containers[0].env);
    const after = structuredClone(before);
    after.spec.template.spec.containers[0].image = 'candidate-image';
    after.status.traffic[0].latestRevision = false;
    expect(verify(before, after, {}, true)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes only explicitly selected env keys and uses file-based update flags for values/references', () => {
    const before = service();
    const updates = {
      CHRONICLER_MODEL: 'new,model=with\nsyntax',
      PGPASSWORD: { secret: 'new-secret', version: '10' },
    };
    const plan = environmentPlan(before, updates);
    expect(plan.flags).toEqual({
      '--update-env-vars': { CHRONICLER_MODEL: updates.CHRONICLER_MODEL },
      '--update-secrets': { PGPASSWORD: 'new-secret:10' },
    });
    const after = structuredClone(before);
    after.spec.template.spec.containers[0].env = plan.env;
    expect(verify(before, after, updates, true)).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.env).toContainEqual({ name: 'UNKNOWN_FUTURE_KEY', value: 'private-config-value' });
  });

  it.each(['env', 'memory', 'maximum', 'identity', 'sql', 'affinity', 'timeout', 'traffic'])(
    'rejects unexpected %s drift without printing secret values',
    (field) => {
      const before = service();
      const after = structuredClone(before);
      if (field === 'env') after.spec.template.spec.containers[0].env.shift();
      if (field === 'memory')
        after.spec.template.spec.containers[0].resources.limits.memory = '1Gi';
      if (field === 'maximum')
        after.spec.template.metadata.annotations['autoscaling.knative.dev/maxScale'] = '3';
      if (field === 'identity') after.spec.template.spec.serviceAccountName = 'other@example.test';
      if (field === 'sql')
        after.spec.template.metadata.annotations['run.googleapis.com/cloudsql-instances'] = 'other';
      if (field === 'affinity')
        after.spec.template.metadata.annotations['run.googleapis.com/sessionAffinity'] = 'false';
      if (field === 'timeout') after.spec.template.spec.timeoutSeconds = 300;
      if (field === 'traffic') after.status.traffic[0].revisionName = 'candidate';
      expect(() => verify(before, after, {}, true)).toThrow('Configuration verification failed');
      try {
        verify(before, after, {}, true);
      } catch (error) {
        expect(String(error)).not.toContain('private-config-value');
      }
    }
  );

  it('requires separate migration approval rather than hiding it in candidate env updates', () => {
    expect(() => validateUpdates({ ATLAS_LEGACY_FEATURE_CUTOVER: 'quiesced-v1' })).toThrow(
      'separately reviewed'
    );
    const live = service();
    live.spec.template.spec.containers[0].env.push({
      name: 'ATLAS_LEGACY_FEATURE_CUTOVER',
      value: 'quiesced-v1',
    });
    expect(() => environmentPlan(live)).toThrow('standalone quiescent migration');
  });

  it('defaults to no traffic and omits config resets, automatic .env loading, and guessed service creation', () => {
    const script = readFileSync(new URL('../../../deploy.sh', import.meta.url), 'utf8');
    const command = script.slice(script.lastIndexOf('gcloud run deploy'));
    expect(command).toContain('--no-traffic');
    for (const flag of [
      '--env-vars-file',
      '--set-env-vars',
      '--set-secrets',
      '--memory',
      '--cpu ',
      '--max-instances',
      '--timeout',
      '--session-affinity',
      '--add-cloudsql-instances',
      '--allow-unauthenticated',
    ])
      expect(command).not.toContain(flag);
    expect(script).not.toContain('load_env_file');
    expect(script).not.toContain('update-traffic');
    expect(script).not.toContain('2>/dev/null || true');
    expect(script).toContain('deploy-config.mjs unchanged');
    expect(script).toContain('deploy-config.mjs deployed');
  });
});
