import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { MessageSquareReply, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { replyAuthor, replySnippet } from "@/lib/replies";
import type { Message } from "@/state/store";

export function ReplyQuote({
  message,
  fallbackName,
  onJump,
  onClear,
  compact = false,
}: {
  message: Message;
  fallbackName?: string;
  onJump?: () => void;
  onClear?: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  return (
    <QuoteRow
      icon={<MessageSquareReply size={compact ? 12 : 14} className="shrink-0 text-accent" />}
      label={t("chat.replyingTo", { name: replyAuthor(message, fallbackName) })}
      text={replySnippet(message.text ?? "")}
      jump={onJump && { onClick: onJump, title: t("chat.jumpToOriginal") }}
      onClear={onClear}
      clearLabel={t("chat.cancelReply")}
    />
  );
}

/** The quote row over the composer: an icon, a label over one truncated line, and an x. */
export function QuoteRow({
  icon,
  label,
  text,
  jump,
  onClear,
  clearLabel,
  className,
  ...props
}: {
  icon: ReactNode;
  label: ReactNode;
  text: ReactNode;
  jump?: ButtonHTMLAttributes<HTMLButtonElement>;
  onClear?: () => void;
  clearLabel?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "children">) {
  const body = (
    <>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[10.5px] font-medium text-accent">{label}</span>
        <span className="block truncate text-[11.5px] text-ink-secondary">{text}</span>
      </span>
    </>
  );
  return (
    <div {...props} className={cn("flex min-w-0 items-center gap-2 rounded-lg border-l-2 border-accent/60 bg-inset/70 px-2.5 py-1.5", className)}>
      {jump ? (
        <button type="button" {...jump} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{body}</div>
      )}
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label={clearLabel}
          className="relative shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink pointer-coarse:after:absolute pointer-coarse:after:-inset-3"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
