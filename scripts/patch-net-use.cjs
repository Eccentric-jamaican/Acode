const childProcess = require('node:child_process');
const originalExec = childProcess.exec;
childProcess.exec = (command, options, callback) => {
  if (typeof command === "string" && command.trim().toLowerCase() === "net use") {
    const cb = typeof options === "function" ? options : callback;
    if (typeof cb === "function") {
      setImmediate(() => cb(null, "", ""));
    }
    return { stdout: '', stderr: '', pid: 0 };
  }
  return originalExec.call(childProcess, command, options, callback);
};
