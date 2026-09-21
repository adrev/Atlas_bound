import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])])
    );
  return value;
}
const stable = (value) => JSON.stringify(sorted(value));
const digest = (value) => createHash('sha256').update(stable(value)).digest('hex');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

export function validateUpdates(updates) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates))
    throw new Error('Environment updates must be a JSON object.');
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid environment key.');
    if (key === 'ATLAS_LEGACY_FEATURE_CUTOVER')
      throw new Error(
        'Legacy cutover approval cannot be set by the candidate deploy script. Run the separately reviewed quiescent migration.'
      );
    if (value === null || typeof value === 'string') continue;
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).sort().join(',') !== 'secret,version' ||
      !/^[A-Za-z0-9_-]+$/.test(value.secret) ||
      !/^(latest|[1-9][0-9]*)$/.test(String(value.version))
    )
      throw new Error(
        `Invalid Secret Manager reference for ${key}; use {secret,version} with a same-project secret name.`
      );
  }
  return updates;
}

function checkService(service) {
  if (!service?.metadata?.name || service.spec?.template?.spec?.containers?.length !== 1)
    throw new Error(
      'Expected an existing single-container service. Multi-container/new-service changes need a separate reviewed operation.'
    );
  if (!service.status?.traffic?.some((entry) => entry.percent > 0 && entry.revisionName))
    throw new Error('Cannot verify current resolved revision traffic.');
}

export function environmentPlan(service, updates = {}) {
  checkService(service);
  validateUpdates(updates);
  const entries = structuredClone(service.spec.template.spec.containers[0].env ?? []);
  if (entries.some((entry) => entry.name === 'ATLAS_LEGACY_FEATURE_CUTOVER'))
    throw new Error(
      'Remove persisted legacy cutover approval from the service before candidate deployment. Approval belongs only to the standalone quiescent migration process.'
    );
  const env = new Map(entries.map((entry) => [entry.name, entry]));
  const flags = {};
  const append = (key, name) => {
    (flags[key] ??= []).push(name);
  };
  for (const [name, value] of Object.entries(updates)) {
    const previous = env.get(name);
    if (value === null) {
      if (previous) append(previous.valueFrom ? '--remove-secrets' : '--remove-env-vars', name);
      env.delete(name);
    } else if (typeof value === 'string') {
      if (previous?.valueFrom) append('--remove-secrets', name);
      (flags['--update-env-vars'] ??= {})[name] = value;
      env.set(name, { name, value });
    } else {
      if (previous && !previous.valueFrom) append('--remove-env-vars', name);
      (flags['--update-secrets'] ??= {})[name] = `${value.secret}:${value.version}`;
      env.set(name, {
        name,
        valueFrom: { secretKeyRef: { name: value.secret, key: String(value.version) } },
      });
    }
  }
  return { flags, env: [...env.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

function annotations(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) =>
        ![
          'run.googleapis.com/client-name',
          'run.googleapis.com/client-version',
          'run.googleapis.com/operation-id',
          'run.googleapis.com/urls',
          'serving.knative.dev/creator',
          'serving.knative.dev/lastModifier',
        ].includes(key)
    )
  );
}

export function configuration(service) {
  checkService(service);
  const spec = structuredClone(service.spec.template.spec);
  delete spec.containers[0].image;
  spec.containers[0].env = (spec.containers[0].env ?? []).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const serviceAnnotations = annotations(service.metadata.annotations);
  const revisionAnnotations = annotations(service.spec.template.metadata?.annotations);
  // Cloud Run may omit annotations representing defaults; compare semantics.
  serviceAnnotations['run.googleapis.com/minScale'] ??= '0';
  revisionAnnotations['autoscaling.knative.dev/minScale'] ??= '0';
  revisionAnnotations['run.googleapis.com/cpu-throttling'] ??= 'true';
  return {
    spec,
    serviceAnnotations,
    revisionAnnotations,
    traffic: service.status.traffic
      .filter((entry) => entry.percent > 0 || entry.tag)
      .map((entry) => ({
        revisionName: entry.revisionName,
        percent: entry.percent ?? 0,
        ...(entry.tag ? { tag: entry.tag } : {}),
      }))
      .sort((a, b) => stable(a).localeCompare(stable(b))),
  };
}

export function verifyCandidate(service, image, revision) {
  if (!/^[^\s]+@sha256:[a-f0-9]{64}$/.test(image ?? '') || !revision)
    throw new Error('An immutable image and exact candidate revision are required.');
  if (
    service.spec?.template?.spec?.containers?.[0]?.image !== image ||
    service.spec?.template?.metadata?.name !== revision ||
    service.status?.latestCreatedRevisionName !== revision
  )
    throw new Error(
      'Candidate identity verification failed; image/revision was replaced or does not match this deployment. No promotion.'
    );
}

export function verify(before, after, updates = {}, deployed = false) {
  if (!deployed) {
    const identity = (service) => ({
      images: service.spec?.template?.spec?.containers?.map((container) => container.image),
      template: service.spec?.template?.metadata?.name ?? null,
      latestCreated: service.status?.latestCreatedRevisionName ?? null,
    });
    if (stable(identity(before)) !== stable(identity(after)))
      throw new Error(
        'Candidate image/revision changed during build; refusing concurrent deployment.'
      );
  }
  const expected = configuration(before);
  if (deployed) {
    expected.spec.containers[0].env = environmentPlan(before, updates).env;
    expected.serviceAnnotations['run.googleapis.com/minScale'] = '0';
    expected.revisionAnnotations['autoscaling.knative.dev/minScale'] = '0';
    expected.revisionAnnotations['run.googleapis.com/cpu-throttling'] = 'true';
  }
  const actual = configuration(after);
  if (stable(expected) !== stable(actual)) {
    const changed = Object.keys(expected).filter(
      (key) => stable(expected[key]) !== stable(actual[key])
    );
    // Never print configuration values, even on failure: they may be secrets.
    throw new Error(
      `Configuration verification failed (${changed.join(', ')}); no traffic promotion. Compare restricted service snapshots before proceeding.`
    );
  }
  return digest(actual);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, beforePath, inputPath, outputOrUpdates, deployedPath, image, revision] =
      process.argv.slice(2);
    const before = read(beforePath);
    if (mode === 'plan') {
      const updates = inputPath === '-' ? {} : read(inputPath);
      const { flags } = environmentPlan(before, updates);
      writeFileSync(outputOrUpdates, JSON.stringify(flags), { mode: 0o600 });
      console.log(
        `Configuration baseline: ${digest(configuration(before))}; explicit env update keys: ${Object.keys(updates).join(', ') || 'none'}`
      );
    } else if (mode === 'unchanged' || mode === 'deployed') {
      const updates = outputOrUpdates === '-' ? {} : read(outputOrUpdates);
      const after = read(inputPath);
      if (mode === 'deployed') {
        // Verify both the deploy response and the fresh final service read.
        verifyCandidate(read(deployedPath), image, revision);
        verifyCandidate(after, image, revision);
      }
      console.log(`Configuration verified: ${verify(before, after, updates, mode === 'deployed')}`);
    } else throw new Error('Invalid configuration verification mode.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
