import { describe, expect, it } from "vitest";

import { redactSecretsInText, StreamSecretMasker } from "./redact";

const secrets = [
  ...["password", "passcode", "pin", "code", "wifi password", "passphrase"]
    .flatMap((name) => [" is ", ": ", "="].map((sep) => [`${name}${sep}sesame`, "sesame"])),
  ["wifi password is bluefish42", "bluefish42"],
  ["my pin is 4471", "4471"],
  ["PASSWORD IS hunter2", "hunter2"],
  ["passcode: 1234", "1234"],
  ["pin=4471", "4471"],
  ["pin=7", "7"],
  ["code is K7PQ2M", "K7PQ2M"],
  ["passphrase is sesame", "sesame"],
  ["password: 'short'", "short"],
  ['passcode = "1234"', "1234"],
  ["비밀번호는 bluefish42", "bluefish42"],
  ["비밀번호: 4471", "4471"],
  ["WiFi비밀번호는 bluefish42", "bluefish42"],
  ['password is "abc-K7PQ2M-def"', "abc-K7PQ2M-def"],
  ["password is abc-K7PQ2M-def", "abc-K7PQ2M-def"],
  ['passphrase is "abc-sk-ant-abcdefghijklmnop-def"', "abc-sk-ant-abcdefghijklmnop-def"],
  ["K7PQ2M", "K7PQ2M"],
  ["join (2ABCDE)!", "2ABCDE"],
];

const ordinary = [
  "the code is in README.md",
  "pin the tab",
  "passwords must be 8 chars",
  "HELLO!",
  "PLEASE",
  "THANKS",
  "234567",
  "K7PQ2MZ",
  "prefixK7PQ2M",
  "K7PQ2M_suffix",
  "한K7PQ2M글",
  "prefixAB2345",
  "K7PO2M",
  "K7PI2M",
  "K7PQ0M",
  "K7PQ1M",
  "k7pq2m",
  "password: leave blank for now",
  "password = getpass.getpass()",
  'password = request.form["password"]',
  "password = $DB_PASSWORD",
  "code is wkr1:pc.relay.example:inv-1",
];

describe("prose secrets and room codes", () => {
  it.each(secrets)("masks %s", (text, secret) => {
    const expected = text.replace(secret, `«redacted ${secret.length} chars»`);
    expect(redactSecretsInText(text)).toBe(expected);
    expect(redactSecretsInText(expected)).toBe(expected);
    for (let split = 1; split < text.length; split++) {
      const masker = new StreamSecretMasker();
      const pieces = [masker.push(text.slice(0, split)), masker.push(text.slice(split)), masker.flush()];
      expect(pieces.join(""), `split ${split}`).toBe(expected);
    }
    const masker = new StreamSecretMasker();
    const pieces = [...text].map((char) => masker.push(char));
    pieces.push(masker.flush());
    expect(pieces.join("")).toBe(expected);
  });

  it.each(ordinary)("preserves %s", (text) => {
    expect(redactSecretsInText(text)).toBe(text);
    const masker = new StreamSecretMasker();
    expect([...text].map((char) => masker.push(char)).join("") + masker.flush()).toBe(text);
  });
});
