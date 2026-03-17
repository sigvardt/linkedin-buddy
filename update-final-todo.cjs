const fs = require('fs');
const file = '/Users/user/.opencode/todo.md';
let todo = fs.readFileSync(file, 'utf8');

todo = todo.replace(/- \[ \] S6\.1\.1:/, '- [x] S6.1.1:');
todo = todo.replace(/status: pending/g, 'status: completed');

fs.writeFileSync(file, todo);
