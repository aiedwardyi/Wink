// Every gate that finds a Usage order bug adds its row here: the saved bytes as stored, then each moment's Claude accounts in the
// server's list order and the order all three account lists show. Only a drag writes, so every moment ranks the same bytes.
// s1 is the base slot; an account signs in as an email the way the server sends it, "checking" before that arrives, null signed out.
export type SignIn = string | null;
export type UsageOrderMoment = { accounts: [id: string, signIn: SignIn][]; main?: string; shows: string[] };
export type UsageOrderRow = { gate: string; row: string; saved: string[]; moments: UsageOrderMoment[] };

export const usageSnapshot = (signIn: SignIn): { state: string; authenticated?: boolean; account?: string } =>
  signIn === "checking" ? { state: "checking" } : { state: "available", authenticated: signIn !== null, ...signIn !== null && { account: signIn } };

const E1 = "account-1@example.com";
const E2 = "account-2@example.com";
const E3 = "account-3@example.com";
const E4 = "account-4@example.com";
const TWIN = "example.person@example.test";
// the shipped build saved slot ids alone, as does an order no drag has saved since; 79ee497e5 added each email as typed, later builds lowercased
const ids = (...slots: string[]) => slots;
const typed = (...pairs: [string, string][]) => pairs.flatMap(([id, email]) => [id, `identity:${email}`]);
const lower = (...pairs: [string, string][]) => pairs.flatMap(([id, email]) => [id, `identity:${email.trim().toLowerCase()}`]);
const all = (signIn?: "checking"): [string, SignIn][] => [["s1", signIn ?? E1], ["s2", signIn ?? E2], ["s3", signIn ?? E3]];

export const USAGE_ORDER_SPEC: UsageOrderRow[] = [
  { gate: "2077", row: "Main switch, Switch and same-slot sign-in keep the saved order", saved: ids("s3", "s2", "s1"), moments: [
    { accounts: all(), shows: ["s3", "s2", "s1"] },
    { accounts: all(), main: "s3", shows: ["s3", "s2", "s1"] },
    { accounts: [["s1", E1], ["s2", null], ["s3", E3]], main: "s3", shows: ["s3", "s2", "s1"] },
    { accounts: all(), shows: ["s3", "s2", "s1"] }] },
  { gate: "2077", row: "restart with every slot checking, then ready", saved: ids("s3", "s2", "s1"), moments: [
    { accounts: all("checking"), shows: ["s3", "s2", "s1"] },
    { accounts: all(), shows: ["s3", "s2", "s1"] }] },
  // decided 11-21: slot ids alone never held the email, so a re-add is new to them until a drag saves emails
  { gate: "2077", row: "a re-add of the same login under slot-id bytes goes last", saved: ids("s3", "s2", "s1"), moments: [
    { accounts: all(), shows: ["s3", "s2", "s1"] },
    { accounts: [["s1", E1], ["s3", E3], ["s2b", "checking"]], shows: ["s3", "s1", "s2b"] },
    { accounts: [["s1", E1], ["s3", E3], ["s2b", E2]], shows: ["s3", "s1", "s2b"] }] },
  { gate: "2077", row: "a genuinely new account goes after the ranked ones", saved: ids("s3", "s2", "s1"), moments: [
    { accounts: [...all(), ["s4", "checking"]], shows: ["s3", "s2", "s1", "s4"] },
    { accounts: [...all(), ["s4", E4]], shows: ["s3", "s2", "s1", "s4"] }] },
  { gate: "2077B", row: "a case-only re-add under bytes a drag saved on 79ee497e5", saved: typed(["s2", "Account-2@Example.COM"], ["s3", E3], ["s1", E1]), moments: [
    { accounts: [["s1", E1], ["s3", E3], ["s2b", "checking"]], shows: ["s2b", "s3", "s1"] },
    { accounts: [["s1", E1], ["s3", E3], ["s2b", E2]], shows: ["s2b", "s3", "s1"] }] },
  { gate: "2077B", row: "a restart after a re-add, the returning slot still checking", saved: lower(["s2", E2], ["s3", E3], ["s1", E1]), moments: [
    { accounts: [["s1", E1], ["s3", E3], ["s2b", E2]], shows: ["s2b", "s3", "s1"] },
    { accounts: [["s1", "checking"], ["s3", "checking"], ["s2b", "checking"]], shows: ["s2b", "s3", "s1"] },
    { accounts: [["s1", E1], ["s3", E3], ["s2b", "checking"]], shows: ["s2b", "s3", "s1"] },
    { accounts: [["s1", E1], ["s3", E3], ["s2b", E2]], shows: ["s2b", "s3", "s1"] }] },
  // decided 11-21: an account no drag has ranked has no saved place, so its re-add is new and goes last
  { gate: "2077B", row: "an unranked account's re-add goes last under a partial order", saved: ids("s1"), moments: [
    { accounts: all(), shows: ["s1", "s2", "s3"] },
    { accounts: [["s1", E1], ["s3", E3], ["s2b", "checking"]], shows: ["s1", "s3", "s2b"] },
    { accounts: [["s1", E1], ["s3", E3], ["s2b", E2]], shows: ["s1", "s3", "s2b"] }] },
  { gate: "2077C", row: "two live slots signed in as one email in another case", saved: ids("s2", "s1", "s3"), moments: [
    { accounts: [["s1", E1], ["s2", "Example.Person@example.test"], ["s3", "example.person@EXAMPLE.test"]], shows: ["s2", "s1", "s3"] },
    { accounts: all("checking"), shows: ["s2", "s1", "s3"] }] },
  { gate: "2077C", row: "two live slots signed in as one email with spaces", saved: ids("s2", "s1", "s3"), moments: [
    { accounts: [["s1", E1], ["s2", TWIN], ["s3", ` ${TWIN} `]], shows: ["s2", "s1", "s3"] }] },
  { gate: "2077C", row: "two live slots signed in as one email under bytes a drag saved", saved: lower(["s2", TWIN], ["s1", E1], ["s3", TWIN]), moments: [
    { accounts: [["s1", E1], ["s2", TWIN], ["s3", TWIN.toUpperCase()]], shows: ["s2", "s1", "s3"] }] },
  { gate: "2077C", row: "a replacement first seen while checking at startup keeps its place", saved: lower(["s2", E2], ["s3", E3], ["s1", E1]), moments: [
    { accounts: [["s1", E1], ["s3", E3], ["s2b", "checking"]], shows: ["s2b", "s3", "s1"] },
    { accounts: [["s1", E1], ["s3", E3], ["s2b", "ACCOUNT-2@example.com"]], shows: ["s2b", "s3", "s1"] }] },
  { gate: "2077C", row: "a mixed-case email 79ee497e5 saved finds its replacement", saved: typed(["s2", "Example.Person@example.test"], ["s3", E3], ["s1", E1]), moments: [
    { accounts: [["s1", E1], ["s3", E3], ["s2b", "checking"]], shows: ["s2b", "s3", "s1"] },
    { accounts: [["s1", E1], ["s3", E3], ["s2b", TWIN]], shows: ["s2b", "s3", "s1"] }] },
  // decided 11-21: a slot first seen while checking fills a free saved place, so a brand-new one drops last once its email arrives
  { gate: "2077D", row: "a brand-new account first seen while checking", saved: lower(["s2", E2], ["s1", E1], ["s3", E3]), moments: [
    { accounts: all(), shows: ["s2", "s1", "s3"] },
    { accounts: [["s1", E1], ["s3", E3], ["s4", "checking"]], shows: ["s4", "s1", "s3"] },
    { accounts: [["s1", E1], ["s3", E3], ["s4", E4]], shows: ["s1", "s3", "s4"] }] },
  // decided 11-21: slots checking fill the free places in list order, each moving to its own once its email arrives
  { gate: "2077D", row: "two returning accounts re-added 3 then 2, both checking", saved: lower(["s2", E2], ["s1", E1], ["s3", E3]), moments: [
    { accounts: all(), shows: ["s2", "s1", "s3"] },
    { accounts: [["s1", E1], ["s3b", "checking"], ["s2b", "checking"]], shows: ["s3b", "s1", "s2b"] },
    { accounts: [["s1", E1], ["s3b", E3], ["s2b", E2]], shows: ["s2b", "s1", "s3b"] }] },
  { gate: "2077D", row: "two returning accounts re-added 2 then 3, both checking", saved: lower(["s2", E2], ["s1", E1], ["s3", E3]), moments: [
    { accounts: all(), shows: ["s2", "s1", "s3"] },
    { accounts: [["s1", E1], ["s2b", "checking"], ["s3b", "checking"]], shows: ["s2b", "s1", "s3b"] },
    { accounts: [["s1", E1], ["s2b", E2], ["s3b", E3]], shows: ["s2b", "s1", "s3b"] }] },
  // decided 11-21: as the 2077 re-add, slot ids alone learn emails only at a drag
  { gate: "2077D", row: "slot-id bytes, a re-add in another case, then restart", saved: ids("s2", "s3", "s1"), moments: [
    { accounts: all(), shows: ["s2", "s3", "s1"] },
    { accounts: [["s1", E1], ["s3", E3], ["s2b", "Account-2@EXAMPLE.com"]], shows: ["s3", "s1", "s2b"] },
    { accounts: [["s1", "checking"], ["s3", "checking"], ["s2b", "checking"]], shows: ["s3", "s1", "s2b"] },
    { accounts: [["s1", E1], ["s3", E3], ["s2b", "Account-2@EXAMPLE.com"]], shows: ["s3", "s1", "s2b"] }] },
  { gate: "rule", row: "a new account ready on first sight never takes a departed account's place", saved: lower(["s2", E2], ["s1", E1], ["s3", E3]), moments: [
    { accounts: [["s1", E1], ["s3", E3], ["s4", E4]], shows: ["s1", "s3", "s4"] }] },
  { gate: "rule", row: "a new account never takes a departed account's place under slot-id bytes", saved: ids("s2", "s1", "s3"), moments: [
    { accounts: [["s1", E1], ["s3", E3], ["s4", "checking"]], shows: ["s1", "s3", "s4"] },
    { accounts: [["s1", E1], ["s3", E3], ["s4", E4]], shows: ["s1", "s3", "s4"] }] },
  { gate: "rule", row: "a new account after a partial order goes last", saved: ids("s1"), moments: [
    { accounts: [["s1", E1], ["s3", E3], ["s4", "checking"]], shows: ["s1", "s3", "s4"] },
    { accounts: [["s1", E1], ["s3", E3], ["s4", E4]], shows: ["s1", "s3", "s4"] }] },
  { gate: "rule", row: "a returning account first seen while checking keeps its place", saved: lower(["s2", E2], ["s1", E1], ["s3", E3]), moments: [
    { accounts: [["s1", E1], ["s3", E3], ["s2b", "checking"]], shows: ["s2b", "s1", "s3"] },
    { accounts: [["s1", E1], ["s3", E3], ["s2b", E2]], shows: ["s2b", "s1", "s3"] }] },
  { gate: "rule", row: "base bytes show as base showed them", saved: ids("s2", "s3", "s1"), moments: [
    { accounts: all("checking"), shows: ["s2", "s3", "s1"] },
    { accounts: all(), shows: ["s2", "s3", "s1"] }] },
  { gate: "rule", row: "79ee497e5 bytes show as it showed them, a twin's email deduped", saved: ["s2", `identity:${TWIN}`, "s1", `identity:${E1}`, "s3"], moments: [
    { accounts: [["s1", E1], ["s2", TWIN], ["s3", TWIN]], shows: ["s2", "s1", "s3"] }] },
  { gate: "rule", row: "3099ca996 and a7f72c9e0 bytes show as they showed them", saved: lower(["s2", E2], ["s3", E3], ["s1", E1]), moments: [
    { accounts: all("checking"), shows: ["s2", "s3", "s1"] },
    { accounts: all(), shows: ["s2", "s3", "s1"] }] },
];
