const fs = require('fs');
const path = require('path');
const file = path.resolve(__dirname, '..', 'src', 'app.tsx');
const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);
const stack = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    if (ch === '{') {
      stack.push({ line: i + 1, col: j + 1, context: line.trim() });
    } else if (ch === '}') {
      if (stack.length === 0) {
        console.warn(`Unmatched closing brace at ${i + 1}:${j + 1}: ${line.trim()}`);
      } else {
        stack.pop();
      }
    }
  }
}
if (stack.length === 0) {
  console.info('All braces matched');
} else {
  console.warn('Unmatched opening braces:');
  for (const s of stack) {
    console.warn(`${s.line}:${s.col} -> ${s.context}`);
  }
}
