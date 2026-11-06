window.dialogResults = [() => alert("fixture"), () => confirm("fixture"), () => prompt("fixture")].map((call) => {
  try { return { returned: call() }; } catch (err) { return { error: err.message }; }
});
window.firstLoadDialogs = window.dialogResults.length;
window.isolationProbe = async function () {
  const { nonce, tcp, udp } = document.body.dataset;
  const negative = `http://127.0.0.1:${tcp}`;
  const attempts = [];
  const tasks = [];
  const attempt = (name, fn) => {
    attempts.push(name);
    tasks.push(Promise.resolve().then(fn).then((value) => ({ name, allowed: true, value: typeof value === "string" || typeof value === "boolean" ? value : undefined }), (err) => ({ name, error: err.name ?? err.message ?? "Denied", code: err.code })));
  };
  for (const method of ["POST", "PUT", "DELETE"]) attempt("write-" + method, () => fetch(location.href, { method }));
  for (const url of [negative + "/http", `https://127.0.0.1:${tcp}/https`, `http://other-${nonce}.localhost:${tcp}/dns`]) attempt(url, () => fetch(url));
  for (const scheme of ["ws", "wss"]) attempt(scheme, () => new Promise((resolve, reject) => { const socket = new WebSocket(`${scheme}://127.0.0.1:${tcp}/socket`); socket.onopen = () => { socket.close(); resolve(); }; socket.onerror = reject; }));
  attempt("beacon", () => navigator.sendBeacon(negative + "/beacon", "fixture"));
  attempt("popup", () => window.open(negative + "/popup"));
  const download = document.createElement("a"); download.href = "/pixel.svg"; download.download = "fixture.svg"; download.click(); attempts.push("download");
  attempt("media", () => navigator.mediaDevices.getUserMedia({ video: true, audio: true }));
  attempt("display", () => navigator.mediaDevices.getDisplayMedia({ video: true }));
  attempt("notification", () => Notification.requestPermission());
  attempt("clipboard", () => navigator.clipboard.readText());
  attempt("geolocation", () => new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 1000 })));
  for (const [name, fn] of [["hid", () => navigator.hid.requestDevice({ filters: [] })], ["serial", () => navigator.serial.requestPort()], ["usb", () => navigator.usb.requestDevice({ filters: [] })], ["bluetooth", () => navigator.bluetooth.requestDevice({ acceptAllDevices: true })]]) attempt(name, fn);
  const frame = document.createElement("iframe"); frame.src = "/render.html"; document.body.append(frame); attempts.push("same-origin-frame");
  for (const scheme of ["file:///C:/Windows/win.ini", "data:text/html,fixture", URL.createObjectURL(new Blob(["fixture"], { type: "text/html" }))]) { const node = document.createElement("iframe"); node.src = scheme; document.body.append(node); attempts.push("document-" + scheme.split(":")[0]); }
  for (const rel of ["dns-prefetch", "preconnect", "prefetch"]) { const link = document.createElement("link"); link.rel = rel; link.href = `http://dynamic-${rel}-${nonce}.localhost:${tcp}/hint`; document.head.append(link); attempts.push(rel); }
  const meta = document.createElement("meta"); meta.httpEquiv = "x-dns-prefetch-control"; meta.content = "on"; document.head.append(meta);
  const dns = document.createElement("link"); dns.rel = "dns-prefetch"; dns.href = `//meta-${nonce}.invalid`; document.head.append(dns); attempts.push("meta-on-dns");
  const speculation = document.createElement("script"); speculation.type = "speculationrules"; speculation.textContent = JSON.stringify({ prefetch: [{ source: "list", urls: [`http://speculation-${nonce}.localhost:${tcp}/prefetch`] }] }); document.head.append(speculation); attempts.push("speculationrules");
  const rtc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${udp}` }, { urls: `turn:127.0.0.1:${tcp}?transport=tcp`, username: "fixture", credential: "fixture" }, { urls: `turns:127.0.0.1:${tcp}?transport=tcp`, username: "fixture", credential: "fixture" }] });
  rtc.createDataChannel("fixture"); await rtc.setLocalDescription(await rtc.createOffer()); attempts.push("stun", "turn-tcp", "turn-tls");
  await Promise.race([Promise.allSettled(tasks), new Promise((resolve) => setTimeout(resolve, 1500))]); rtc.close();
  return { attempts, node: typeof process, require: typeof require, bridge: typeof window.verifyWall, popup: window.open("about:blank") === null, firstLoadDialogs: window.firstLoadDialogs, dialogError: window.dialogError, assets: await fetch("/pixel.svg").then((r) => r.ok), cookies: document.cookie, frameNode: typeof frame.contentWindow.process, measurements, checks: await Promise.all(tasks.map((task) => Promise.race([task, new Promise((resolve) => setTimeout(() => resolve({ pending: true }), 10))]))) };
};
