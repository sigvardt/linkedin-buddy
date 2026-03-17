const fs = require('fs');
const file = '/Users/user/.opencode/todo.md';
let todo = fs.readFileSync(file, 'utf8');

todo = todo.replace(/- \[ \] S2\.1\.1:/, '- [x] S2.1.1:');
todo = todo.replace(/- \[ \] S2\.1\.2:/, '- [x] S2.1.2:');
todo = todo.replace(/status: in_progress/, 'status: completed');

todo = todo.replace(/- \[ \] S3\.1\.1:/, '- [x] S3.1.1:');
todo = todo.replace(/- \[ \] S3\.1\.2:/, '- [x] S3.1.2:');
todo = todo.replace(/- \[ \] S3\.2\.1:/, '- [x] S3.2.1:');

todo = todo.replace(/- \[ \] S4\.1\.1:/, '- [x] S4.1.1:');
todo = todo.replace(/- \[ \] S4\.1\.2:/, '- [x] S4.1.2:');
todo = todo.replace(/- \[ \] S4\.2\.1:/, '- [x] S4.2.1:');

fs.writeFileSync(file, todo);
