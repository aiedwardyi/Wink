// Test helper only: production code never imports this.
export type IdentityCanary = { address: string; local: string; domain: string };
export type CanaryHit = { part: "address" | "local" | "domain"; where: string };

const token = (length: number) => {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => "bcdfghjkmnpqrstvwxz"[byte % 19]).join("");
};

/** A fresh synthetic identity: random consonant runs, so it never matches a word on screen. */
export function makeIdentityCanary(): IdentityCanary {
  const local = `q${token(11)}`;
  const domain = `x${token(9)}.invalid`;
  return { address: `${local}@${domain}`, local, domain };
}

function describe(element: Element): string {
  const id = element.id ? `#${element.id}` : "";
  return `${element.tagName.toLowerCase()}${id}`;
}

/** Every place the canary's full form, local part or domain shows: text, attributes and form values, hidden or not. */
export function scanForCanary(canary: IdentityCanary, root: ParentNode = document): CanaryHit[] {
  const hits: CanaryHit[] = [];
  const parts = [["address", canary.address], ["local", canary.local], ["domain", canary.domain]] as const;
  const check = (value: string | null | undefined, where: string) => {
    if (!value) return;
    const lower = value.toLowerCase();
    for (const [part, needle] of parts) if (lower.includes(needle.toLowerCase())) hits.push({ part, where });
  };
  const body = root instanceof Document ? root.body : root;
  check(body?.textContent, "text");
  if (root instanceof Document) check(root.title, "title");
  const elements = root instanceof Document ? root.querySelectorAll("*") : (root as Element).querySelectorAll?.("*") ?? [];
  for (const element of [...(root instanceof Element ? [root] : []), ...elements]) {
    for (const attribute of element.attributes) check(attribute.value, `${describe(element)}[${attribute.name}]`);
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) check(element.value, `${describe(element)}.value`);
    if (element instanceof HTMLSelectElement) for (const option of element.options) check(option.value, `${describe(element)} option`);
  }
  return hits;
}
