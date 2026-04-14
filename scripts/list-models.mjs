const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  throw new Error('Missing Gemini API key. Set GEMINI_API_KEY before running this script.');
}

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
