const API_KEY = 'AIzaSyAX4yOSVOghzkMLG26tKdDUXnjqqnDINYc';
const URL = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${API_KEY}`;
const resp = await fetch(URL, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({instances:[{prompt:'a simple red circle on white background, digital art, no text'}],parameters:{sampleCount:1,aspectRatio:'1:1'}})});
console.log('Status:', resp.status);
if (resp.ok) { const d = await resp.json(); console.log(d.predictions?.[0]?.bytesBase64Encoded ? 'API working' : 'No image'); }
else { const t = await resp.text(); console.log(t.substring(0, 200)); }
