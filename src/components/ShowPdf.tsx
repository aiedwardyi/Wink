import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { useI18n } from "@/lib/i18n";

// Older builds served this file with a type a module worker refuses, cached for a year.
GlobalWorkerOptions.workerSrc = `${worker}?v=2`;

/** One page at a time, drawn sharp and scaled down to fit. */
export default function ShowPdf({ src, onReady, onFail }: { src: string; onReady(): void; onFail(): void }) {
  const { t } = useI18n();
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const canvas = useRef<HTMLCanvasElement>(null);
  const done = useRef({ onReady, onFail });
  done.current = { onReady, onFail };

  useEffect(() => {
    const task = getDocument({ url: src, isEvalSupported: false });
    let alive = true;
    task.promise.then(loaded => { if (alive) setDoc(loaded); }, () => { if (alive) done.current.onFail(); });
    return () => { alive = false; void task.destroy(); };
  }, [src]);

  useEffect(() => {
    if (!doc) return;
    let alive = true;
    let drawing: { cancel(): void } | null = null;
    doc.getPage(page).then(async (pdfPage) => {
      const el = canvas.current;
      if (!alive || !el) return;
      const viewport = pdfPage.getViewport({ scale: 2 });
      el.width = viewport.width;
      el.height = viewport.height;
      const context = el.getContext("2d");
      if (context) {
        const task = pdfPage.render({ canvasContext: context, viewport });
        drawing = task;
        await task.promise;
      }
      if (alive) done.current.onReady();
    }).catch(() => {});
    return () => { alive = false; drawing?.cancel(); };
  }, [doc, page]);

  return (
    <>
      <canvas ref={canvas} className="show-pdf" />
      {doc && (
        <div data-show-pager className="show-pager">
          <button type="button" className="verify-watch-icon" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label={t("show.previous")} title={t("show.previous")}><ChevronLeft size={16} /></button>
          <span>{t("show.page", { page, pages: doc.numPages })}</span>
          <button type="button" className="verify-watch-icon" disabled={page >= doc.numPages} onClick={() => setPage(page + 1)} aria-label={t("show.next")} title={t("show.next")}><ChevronRight size={16} /></button>
        </div>
      )}
    </>
  );
}
