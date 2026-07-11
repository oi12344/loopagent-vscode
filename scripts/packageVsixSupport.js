function appendLine(output, value) {
  if (!value) {
    return output;
  }

  return output + value + (value.endsWith("\n") ? "" : "\n");
}

function formatVsceFailure({ exitCode, signal, stdout, stderr }) {
  let output = appendLine("", stdout);
  output = appendLine(output, stderr);
  return `${output}VSCE packaging failed (exitCode=${String(exitCode)}, signal=${signal ?? "none"})\n`;
}

module.exports = { formatVsceFailure };
