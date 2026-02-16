const text = process.env.TEXT || 'Hello world';
const res = await fetch('http://localhost:3000/api/translate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text })
});
const payload = await res.json().catch(() => null);
console.log(JSON.stringify({ status: res.status, payload }, null, 2));

