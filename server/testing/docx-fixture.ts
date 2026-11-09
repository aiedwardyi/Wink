import { deflateRawSync } from "node:zlib";

/** A .docx with one word/document.xml holding these paragraphs; "\f" starts a page break run. */
export function docxFixture(paragraphs: string[], rendered = false): Buffer {
  const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const run = (text: string) => text.split("\t").map(part => `<w:t xml:space="preserve">${esc(part)}</w:t>`).join("<w:tab/>");
  const body = paragraphs.map(text => text.startsWith("\f")
    ? `<w:p><w:r>${rendered ? "<w:lastRenderedPageBreak/>" : `<w:br w:type="page"/>`}${run(text.slice(1))}</w:r></w:p>`
    : `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:b/></w:rPr>${run(text)}</w:r></w:p>`).join("");
  return zipFixture({
    "[Content_Types].xml": `<?xml version="1.0"?><Types/>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="w"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  });
}

export function zipFixture(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), data = deflateRawSync(raw), path = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(path.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(path.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, path, data); centrals.push(central, path);
    offset += 30 + path.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
