const API_KEY = 'REDACTED_API_KEY';

const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`);
const data = await resp.json();
const models = data.models || [];

console.log('Image-capable models:');
models.filter(m =>
  m.name.includes('imagen') ||
  m.name.includes('nano') ||
  m.name.includes('banana') ||
  m.supportedGenerationMethods?.includes('generateImages') ||
  m.supportedGenerationMethods?.includes('predict')
).forEach(m => {
  console.log(`  ${m.name} - ${m.supportedGenerationMethods?.join(', ')}`);
});

console.log('\nAll models with "generate" in methods:');
models.filter(m => m.supportedGenerationMethods?.some(s => s.includes('generate'))).forEach(m => {
  console.log(`  ${m.name} - ${m.supportedGenerationMethods?.join(', ')}`);
});
