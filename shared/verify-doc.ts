export type VerifyDocKind = "spelling" | "grammar" | "translation" | "names" | "numbering";
export const VERIFY_DOC_KINDS: readonly VerifyDocKind[] = ["spelling", "grammar", "translation", "names", "numbering"];

export interface VerifyDocFinding {
  kind: VerifyDocKind;
  /** 1-based */
  line: number;
  page: number;
  quote: string;
  /** "" when there is no single right text, e.g. a reference to a missing article */
  fix: string;
  note?: string;
}

/** VerifyCardData.doc: the card is a document check, not a page check. */
export interface VerifyDocData {
  pages: number;
  lines: number;
  chunks: [done: number, total: number];
  /** the page being checked while it runs */
  page?: number;
  /** last progress, epoch ms: a long check is not stale while it moves */
  beat?: number;
  by?: Partial<Record<VerifyDocKind, number>>;
  findings?: VerifyDocFinding[];
  findingTotal?: number;
  /** characters past the cap that were not checked */
  cut?: number;
  /** the names and dates comparison failed */
  uncompared?: boolean;
  /** the bot's fix turn has these findings */
  fixing?: boolean;
  /** findings the bot's fix turns removed */
  fixedFindings?: VerifyDocFinding[];
}

/** .lvr marks of a document check */
export type VerifyDocMark =
  | { ms: number; kind: "doc-text"; lines: string[]; pageStarts: number[] }
  | { ms: number; kind: "doc-chunk"; from: number; to: number; state: "start" | "done" }
  | { ms: number; kind: "doc-finding"; finding: VerifyDocFinding };

export const VERIFY_DOC_FINDINGS = 60;
