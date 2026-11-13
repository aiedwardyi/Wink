import { describe, expect, it } from "vitest";

import { redactRoomMemory, redactSecretsInText, StreamSecretMasker } from "./redact";

const secrets = [
  ...["password", "passcode", "wifi password", "passphrase"]
    .flatMap((name) => [" is ", ": ", "="].map((sep) => [`${name}${sep}sesame42`, "sesame42"])),
  ["wifi password is Hx7!kq92", "Hx7!kq92"],
  ["wifi password is bluefish42", "bluefish42"],
  ["PASSWORD IS hunter2", "hunter2"],
  ["passcode: 1234", "1234"],
  ["passphrase is open-sesame!", "open-sesame!"],
  ['passcode = "1234"', "1234"],
  ["비밀번호는 bluefish42", "bluefish42"],
  ["비밀번호: 4471", "4471"],
  ["WiFi비밀번호는 bluefish42", "bluefish42"],
  ['password is "abc-K7PQ2M-def"', "abc-K7PQ2M-def"],
  ["password is abc-K7PQ2M-def", "abc-K7PQ2M-def"],
  ['passphrase is "abc1-sk-ant-abcdefghijklmnop-def"', "abc1-sk-ant-abcdefghijklmnop-def"],
  ["K7PQ2M", "K7PQ2M"],
  ["invite code K7MZ3Q", "K7MZ3Q"],
  ["join (2ABCDE)!", "2ABCDE"],
];

const walker = [
  "The code is ready.",
  "exit code: 1 and error code: 404",
  "the password is stored in .env",
  "use color #3B82F6 and #E5E7EB",
  "my pin is on the fridge",
  "...and the code is clean now",
];

const ordinary = [
  ...walker,
  "the code is in README.md",
  "pin the tab",
  "passwords must be 8 chars",
  "password is sesame",
  "pin=7",
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

const streamed = (text: string) => {
  const masker = new StreamSecretMasker();
  return [...text].map((char) => masker.push(char)).join("") + masker.flush();
};

describe("prose secrets and room codes in room memory", () => {
  it.each(secrets)("masks %s", (text, secret) => {
    const expected = text.replace(secret, `«redacted ${secret.length} chars»`);
    expect(redactRoomMemory(text)).toBe(expected);
    expect(redactRoomMemory(expected)).toBe(expected);
  });

  it.each(ordinary)("preserves %s", (text) => {
    expect(redactRoomMemory(text)).toBe(text);
  });
});

describe("ordinary bot text", () => {
  it.each(walker)("passes %s through unchanged", (text) => {
    expect(redactSecretsInText(text)).toBe(text);
    expect(streamed(text)).toBe(text);
    for (let split = 1; split < text.length; split++) {
      const masker = new StreamSecretMasker();
      expect(masker.push(text.slice(0, split)) + masker.push(text.slice(split)) + masker.flush(), `split ${split}`).toBe(text);
    }
  });
});
