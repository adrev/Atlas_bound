const API_KEY = 'AIzaSyAX4yOSVOghzkMLG26tKdDUXnjqqnDINYc';
const URL = `https://generativelanguage.googleapis.com/v1beta/models/nano-banana-pro-preview:generateContent?key=${API_KEY}`;

const resp = await fetch(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    contents: [{
      parts: [{ text: 'Generate an image of a simple red circle on a white background, digital art' }]
    }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
    }
  })
});

console.log('Status:', resp.status);
if (resp.ok) {
  const data = await resp.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData) {
      console.log('Got image!', Math.round(part.inlineData.data.length / 1024), 'KB base64');
    } else if (part.text) {
      console.log('Text:', part.text.substring(0, 100));
    }
  }
} else {
  const t = await resp.text();
  console.log(t.substring(0, 300));
}
