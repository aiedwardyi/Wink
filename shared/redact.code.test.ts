import { describe, expect, it } from "vitest";

import { redactSecretsInText, StreamSecretMasker } from "./redact";

const a = "abcdefghijklmnopqrstuvwxyz0123456789";

const CODE_LINES = [
  'const token = localStorage.getItem("token")',
  'API_KEY = os.environ["API_KEY"]',
  "secret: process.env.JWT_SECRET",
  "password = getpass.getpass()",
  "const apiKey = process.env.OPENAI_API_KEY;",
  "auth_token: req.headers.authorization,",
  'const token = sessionStorage.getItem("access_token");',
  "const apiKey = import.meta.env.VITE_API_KEY;",
  'const secret = process.env["JWT_SECRET"];',
  "const token = req.cookies.session_token;",
  "headers.authorization = config.headers.Authorization;",
  'const secret = Buffer.from(raw, "base64");',
  'let token = localStorage?.getItem("token");',
  "  apiKey: process.env.STRIPE_SECRET_KEY,",
  "const token = jwt.sign(payload, secretKey);",
  'private readonly secret = configService.getOrThrow("JWT_SECRET");',
  "const token = getAuthToken();",
  "const password = hashPassword(input);",
  'token = os.getenv("GITHUB_TOKEN")',
  'api_key = os.environ.get("OPENAI_API_KEY")',
  "SECRET_KEY = settings.DJANGO_SECRET_KEY",
  'password = request.form["password"]',
  'self.api_key = kwargs.get("api_key")',
  "token = credentials.token",
  'secret = keyring.get_password("svc", user)',
  '\tAPIKey: os.Getenv("API_KEY"),',
  '\tPassword: viper.GetString("db.password"),',
  '\tAccessKey: aws.String(os.Getenv("AWS_ACCESS_KEY_ID")),',
  "let password = PasswordHash::new(&hash)?;",
  "let secret = SecretString::from(raw);",
  "let token = config.github.token.clone();",
  "    api_key: settings.api_key.clone(),",
  "let token = TokenStore::global().get();",
  "export NPM_TOKEN=$CI_NPM_TOKEN",
  'curl -H "x-api-key: $ANTHROPIC_API_KEY" https://api.anthropic.com/v1/messages',
  'PASSWORD="$DB_PASSWORD" ./migrate.sh',
  "docker login -u ci --password=$REGISTRY_PASSWORD registry.example.com",
  "TOKEN=${GITHUB_TOKEN}",
  "  password: ${DB_PASSWORD}",
  "  api_key: $OPENAI_API_KEY",
  "  token: ${{ secrets.GITHUB_TOKEN }}",
  "  client_secret: env.OAUTH_CLIENT_SECRET",
  '  "apiKey": "$API_KEY",',
  '  "token": "${NPM_TOKEN}"',
  '{"password": "$PGPASSWORD"}',
];

// Expected is the output before code values were let through.
const SECRETS: Array<[string, string]> = [
  [`ANTHROPIC_API_KEY=${"sk-" + "ant-"}api03-${a}`, "ANTHROPIC_API_KEY=«redacted 49 chars»"],
  [`OPENAI_API_KEY="${"sk-" + "proj-"}${a}ABCD"`, "OPENAI_API_KEY=\"«redacted 48 chars»\""],
  [`GITHUB_TOKEN=${"gh" + "p_"}${a}`, "GITHUB_TOKEN=«redacted 40 chars»"],
  [`{"token": "${"github_" + "pat_"}11ABCDEFG0${a}"}`, "{\"token\": \"«redacted 57 chars»\"}"],
  [`SLACK_BOT_TOKEN=${"xox" + "b-"}123456789012-1234567890123-${a.slice(0, 24)}`, "SLACK_BOT_TOKEN=«redacted 56 chars»"],
  [`aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`, "aws_secret_access_key = «redacted 40 chars»"],
  [`GOOGLE_API_KEY=${"AIza" + "SyA-"}${a.slice(0, 32)}`, "GOOGLE_API_KEY=«redacted 40 chars»"],
  [`NPM_TOKEN=${"npm" + "_"}${a}`, "NPM_TOKEN=«redacted 40 chars»"],
  [`STRIPE_SECRET_KEY=${"sk" + "_"}live_51H${a.slice(0, 30)}`, "STRIPE_SECRET_KEY=«redacted 41 chars»"],
  [`XAI_API_KEY=${"xai" + "-"}${a}`, "XAI_API_KEY=«redacted 40 chars»"],
  [`token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`, "token: «redacted 108 chars»"],
  [`const token = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJodHRwcyJ9.c2lnbmF0dXJlLXZhbHVl";`, "const token = \"«redacted 62 chars»\";"],
  [`id_token = eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJodHRwcyJ9.c2lnbmF0dXJlLXZhbHVl`, "id_token = «redacted 62 chars»"],
  [`session_token=Zm9vYmFy.YmF6cXV4.cXV1eA`, "session_token=«redacted 24 chars»"],
  [`refresh_token: QWxhZGRpbjpvcGVu.c2VzYW1lU2VzYW1l.T3BlblNlc2FtZQ`, "refresh_token: «redacted 48 chars»"],
  [`token=aB3dE5fG7hJ9.kL2mN4`, "token=«redacted 19 chars»"],
  [`secret=3f2a9c1e7b4d5a6f8e9c0b1a2d3e4f5a`, "secret=«redacted 32 chars»"],
  [`{"api_key": "a1b2c3d4e5f60718293a4b5c6d7e8f90"}`, "{\"api_key\": \"«redacted 32 chars»\"}"],
  [`WEBHOOK_SECRET=deadbeefcafebabe0123456789abcdef`, "WEBHOOK_SECRET=«redacted 32 chars»"],
  [`token=abcdef12.34567890`, "token=«redacted 17 chars»"],
  [`secret: dGhpcyBpcyBhIHNlY3JldA==`, "secret: «redacted 24 chars»"],
  [`CLIENT_SECRET='Zm9vYmFyYmF6cXV4cXV1eA=='`, "CLIENT_SECRET='«redacted 24 chars»'"],
  [`password=P@ssw0rd!2024`, "password=«redacted 13 chars»"],
  [`DB_PASSWORD="hunter2hunter2"`, "DB_PASSWORD=\"«redacted 14 chars»\""],
  [`password: Tr0ub4dor&3xyz`, "password: «redacted 9 chars»&3xyz"],
  [`passwd=correct-horse-battery`, "passwd=«redacted 21 chars»"],
  [`password='S3cure#Pass$word'`, "password='«redacted 16 chars»'"],
  [`PG_PASSWORD=s3cr3t_p4ss`, "PG_PASSWORD=«redacted 11 chars»"],
  [`password = "Summer.2024!"`, "password = \"«redacted 12 chars»\""],
  [`admin_password: Xk9mQ2vL8pR4`, "admin_password: «redacted 12 chars»"],
  [`password=hunter2.hunter2`, "password=«redacted 15 chars»"],
  [`password=Summer.2024`, "password=«redacted 11 chars»"],
  [`{"client_secret":"${"GOCSPX" + "-"}abcDEF123ghiJKL456mno"}`, "{\"client_secret\":\"«redacted 28 chars»\"}"],
  [`"private_key": "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"`, "\"private_key\": \"«redacted 32 chars»\""],
  [`token=$ecretValue99`, "token=«redacted 13 chars»"],
  [`api_key=$A1B2C3D4E5F6`, "api_key=«redacted 13 chars»"],
  [`secret=MySuperSecretValue`, "secret=«redacted 18 chars»"],
  [`TOKEN="ABCDEFGHIJKLMNOPQRSTUVWX"`, "TOKEN=\"«redacted 24 chars»\""],
  [`password: "$uperS3cret!"`, "password: \"«redacted 12 chars»\""],
  [`api-key: 9f86d081884c7d659a2feaa0c55ad015`, "api-key: «redacted 32 chars»"],
  [`토큰 설정: token=Qm9vdHN0cmFw2024`, "토큰 설정: token=«redacted 16 chars»"],
  [`password=Xk9mQ2vL8pR4zT(`, "password=«redacted 14 chars»("],
  [`access_key="${"AKIA" + "WXYZABCDEFGH1234"}"`, "access_key=\"«redacted 20 chars»\""],
  [`SECRET_KEY=9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b`, "SECRET_KEY=«redacted 40 chars»"],
  [`auth_token = 'tok_9xK2mP7qR4sT1vW8yZ3'`, "auth_token = '«redacted 23 chars»'"],
  [`export DATABASE_PASSWORD=hunter2hunter2`, "export DATABASE_PASSWORD=«redacted 14 chars»"],
  [`--token=abc123def456`, "--token=«redacted 12 chars»"],
  [`client_secret: 'zzzz-yyyy-xxxx-1'`, "client_secret: '«redacted 16 chars»'"],
  [`password=OpenSesame.v2.Xk9q`, "password=«redacted 18 chars»"],
  [`api_key=prodKey.aB1cD2eF3gH4`, "api_key=«redacted 20 chars»"],
  [`token=a8f3k2m9.x7q1`, "token=«redacted 13 chars»"],
  [`secret=Rt5.Yu8.Io3.Pq7`, "secret=«redacted 15 chars»"],
];

// Dotted words off a receiver that is not a known code object stay masked.
const DOTTED: Array<[string, string]> = [
  ["password=hunter2.example", "password=«redacted 15 chars»"],
  ["password: Summer.Vacation", "password: «redacted 15 chars»"],
  ["secret=correct.horse.battery", "secret=«redacted 21 chars»"],
  ["this.password = form.password.value;", "this.password = «redacted 19 chars»;"],
  ["const access_token = response.data.access_token;", "const access_token = «redacted 26 chars»;"],
  ["\tToken: cfg.Auth.Token,", "\tToken: «redacted 14 chars»,"],
];

function streamed(chunks: string[]) {
  const masker = new StreamSecretMasker();
  const pieces = chunks.map((chunk) => masker.push(chunk));
  pieces.push(masker.flush());
  return { pieces, out: pieces.join("") };
}

const everySplit = (text: string) => Array.from({ length: text.length - 1 }, (_, i) => [text.slice(0, i + 1), text.slice(i + 1)]);

describe("code that reads a credential", () => {
  it.each(CODE_LINES)("keeps %s", (line) => {
    expect(redactSecretsInText(line)).toBe(line);
    expect(streamed([`${line}\n}`]).pieces[0]).toBe(`${line}\n}`);
    for (const chunks of everySplit(line)) expect(streamed(chunks).out, JSON.stringify(chunks)).toBe(line);
  });
});

describe("credential values", () => {
  it.each(SECRETS)("masks %s", (text, expected) => {
    expect(redactSecretsInText(text)).toBe(expected);
    let start = 0;
    while (text[start] === expected[start]) start += 1;
    let end = 0;
    while (text.at(-1 - end) === expected.at(-1 - end)) end += 1;
    const secret = text.slice(start, text.length - end);
    for (const chunks of everySplit(text)) {
      const { pieces, out } = streamed(chunks);
      expect(out, JSON.stringify(chunks)).toBe(expected);
      for (const piece of pieces) expect(piece).not.toContain(secret.slice(0, Math.min(6, secret.length)));
    }
  });
});

describe("dotted values", () => {
  it.each(DOTTED)("masks %s", (text, expected) => {
    expect(redactSecretsInText(text)).toBe(expected);
    for (const chunks of everySplit(text)) expect(streamed(chunks).out, JSON.stringify(chunks)).toBe(expected);
  });
});
