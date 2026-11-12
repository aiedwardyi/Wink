// A short room code typed as six boxes, like a sign-up verify code.
import { useEffect, useRef } from "react";

export const SHORT_CODE_LENGTH = 6;
const KEEP = /[^2-9A-HJ-NP-Z]/g;
const PASTED = /^[2-9A-HJ-NP-Z]{1,6}$/;

// With Korean input on, letters arrive as Hangul; NFKD turns IME jamo and syllables into conjoining jamo, keyed here by 2-set layout.
const HANGUL_KEYS: Array<[number, string[]]> = [
  [0x1100, "R R S E E F A Q Q T T D W W C Z X V G".split(" ")],
  [0x1161, "K O I O J P U P H HK HO HL Y N NJ NP NL B M ML L".split(" ")],
  [0x11a8, "R R RT S SW SG E F FR FA FQ FT FX FV FG A Q QT T T D W C Z X V G".split(" ")],
];
const keyOf = (ch: string) => {
  const point = ch.codePointAt(0)!;
  for (const [start, keys] of HANGUL_KEYS) if (point >= start && point < start + keys.length) return keys[point - start];
  return ch;
};

export const shortCodeChars = (text: string) => [...text.normalize("NFKD")].map(keyOf).join("").toUpperCase().replace(KEEP, "");

export const BOX = "size-11 rounded-lg border border-hairline/60 bg-inset text-center font-mono text-[18px] font-semibold text-ink";

export function CodeBoxes({ value, onChange, onDone, onOther, label, disabled }: {
  value: string;
  onChange(value: string): void;
  onDone(code: string): void;
  /** A paste that isn't a short code, such as a long one, handed over whole. */
  onOther(text: string): void;
  label: string;
  disabled?: boolean;
}) {
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const want = useRef<number | null>(null);
  // Moves focus once the new value has rendered, so the clamp below sees it.
  const focus = (i: number) => { want.current = Math.min(i, SHORT_CODE_LENGTH - 1); };
  useEffect(() => {
    if (want.current === null) return;
    boxes.current[want.current]?.focus();
    want.current = null;
  });

  const put = (from: number, chars: string) => {
    const next = (value.slice(0, from) + chars).slice(0, SHORT_CODE_LENGTH);
    onChange(next);
    focus(next.length);
    if (next.length === SHORT_CODE_LENGTH) onDone(next);
  };

  return (
    <div role="group" aria-label={label} className="flex justify-between gap-2">
      {Array.from({ length: SHORT_CODE_LENGTH }, (_, i) => (
        <input
          key={i}
          ref={(el) => { boxes.current[i] = el; }}
          value={value[i] ?? ""}
          readOnly={disabled}
          aria-label={`${label} ${i + 1}`}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="one-time-code"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          onFocus={(e) => {
            if (i > value.length) focus(value.length);
            else e.currentTarget.select();
          }}
          onChange={(e) => {
            const chars = shortCodeChars(e.target.value.replace(value[i] ?? "", ""));
            if (chars) put(Math.min(i, value.length), chars);
            else onChange(value);
          }}
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain").trim();
            const chars = text.toUpperCase().replace(/[\s-]/g, "");
            if (PASTED.test(chars)) put(0, chars);
            else onOther(text);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Backspace") return;
            e.preventDefault();
            const at = value[i] ? i : i - 1;
            if (at < 0) return;
            onChange(value.slice(0, at));
            focus(at);
          }}
          className={`${BOX} outline-none focus:border-accent disabled:opacity-60`}
        />
      ))}
    </div>
  );
}
