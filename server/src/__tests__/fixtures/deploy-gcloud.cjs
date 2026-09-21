// Local test executable only. Unknown operations fail instead of reaching gcloud.
const fs = require('node:fs');
const args = process.argv.slice(2);
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
const log = (entry) => fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(entry) + '\n');
const state = fs.existsSync(process.env.MOCK_STATE)
  ? read(process.env.MOCK_STATE)
  : { describes: 0 };
const before = read(process.env.MOCK_BEFORE);
if (args.slice(0, 3).join(' ') === 'run services describe') {
  state.describes++;
  write(process.env.MOCK_STATE, state);
  log({ operation: 'describe' });
  const service = state.after ?? before;
  if (process.env.MOCK_CONCURRENT && state.describes === 2) {
    service.spec.template.spec.containers[0].image = 'concurrent-image';
    service.spec.template.metadata.name = 'concurrent-revision';
  }
  process.stdout.write(JSON.stringify(service));
} else if (args.slice(0, 2).join(' ') === 'run deploy') {
  const flags = read(args[args.indexOf('--flags-file') + 1]);
  if (!args.includes('--no-traffic')) throw new Error('Test refuses traffic promotion');
  log({ operation: 'deploy', args, flags });
  state.after = structuredClone(before);
  const container = state.after.spec.template.spec.containers[0];
  container.image = args[args.indexOf('--image') + 1];
  const env = new Map(container.env.map((entry) => [entry.name, entry]));
  for (const name of [...(flags['--remove-env-vars'] ?? []), ...(flags['--remove-secrets'] ?? [])])
    env.delete(name);
  for (const [name, value] of Object.entries(flags['--update-env-vars'] ?? {}))
    env.set(name, { name, value });
  for (const [name, value] of Object.entries(flags['--update-secrets'] ?? {})) {
    const [secret, version] = value.split(':');
    env.set(name, { name, valueFrom: { secretKeyRef: { name: secret, key: version } } });
  }
  container.env = [...env.values()];
  state.after.metadata.annotations['run.googleapis.com/minScale'] = '0';
  state.after.spec.template.metadata.annotations['autoscaling.knative.dev/minScale'] = '0';
  state.after.spec.template.metadata.annotations['run.googleapis.com/cpu-throttling'] = 'true';
  state.after.spec.template.metadata.name = 'candidate-revision';
  state.after.status.latestCreatedRevisionName = 'candidate-revision';
  write(process.env.MOCK_STATE, state);
} else {
  throw new Error(`Unexpected mock CLI operation: ${args.slice(0, 3).join(' ')}`);
}
