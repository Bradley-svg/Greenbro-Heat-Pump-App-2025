const fs = require('fs');
const path = 'd:/Work/GREENBRO/Greenbro-Heat-Pump-App-2025/src/app.tsx';
const s = fs.readFileSync(path, 'utf8');
const lines = s.split(/\r?\n/);
let open = 0;
const out = [];
for (let i = 0; i < lines.length; i++) {
  const o = (lines[i].match(/\{/g) || []).length;
  const c = (lines[i].match(/\}/g) || []).length;
  const old = open;
  open += o - c;
  if (open > old) {
    out.push(`${i + 1}: +${open - old} delta=${open} -> ${lines[i].replace(/\r|\n/g, '').slice(0,200)}`);
  }
}
out.push('FINAL delta=' + open);
fs.writeFileSync('d:/Work/GREENBRO/Greenbro-Heat-Pump-App-2025/brace_report_output.txt', out.join('\n'), 'utf8');
console.log('wrote report to brace_report_output.txt');
