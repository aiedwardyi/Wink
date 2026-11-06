function color(value, background) {
  if (typeof value === "number") return `${background ? 48 : 38};5;${value}`;
  if (/^#[a-f\d]{6}$/i.test(value ?? "")) return `${background ? 48 : 38};2;${[1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)).join(";")}`;
  return background ? "49" : "39";
}

export function workerHostScreen(snapshot) {
  let output = "\x1bc";
  if (snapshot.recentText) output += `${snapshot.recentText.replaceAll("\n", "\r\n")}\r\n`;
  if (snapshot.alternate) output += "\x1b[?1049h";
  output += "\x1b[2J\x1b[H";
  const rows = snapshot.screenRuns ?? snapshot.screenText.split("\n").map((t) => [{ t }]);
  for (let row = 0; row < rows.length; row++) {
    output += `\x1b[${row + 1};1H`;
    for (const run of rows[row]) {
      const codes = [0, color(run.fg, false), color(run.bg, true)];
      for (const [key, code] of [["b", 1], ["d", 2], ["i", 3], ["u", 4], ["s", 9]]) if (run[key]) codes.push(code);
      output += `\x1b[${codes.join(";")}m${run.t}`;
    }
  }
  output += "\x1b[0m";
  for (const mode of snapshot.resetModes ?? []) output += `\x1b[?${mode}l`;
  for (const mode of snapshot.modes ?? []) output += `\x1b[?${mode}h`;
  return `${output}\x1b[${snapshot.cursor.row + 1};${snapshot.cursor.col + 1}H`;
}
